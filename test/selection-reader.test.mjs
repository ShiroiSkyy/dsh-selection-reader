/**
 * 划词解读 · 纯逻辑单测
 *
 * client.js 是浏览器端模块，这里直接抽取其中标记的纯逻辑区域执行，
 * 覆盖「同对话同轮次覆盖 / 缓存命中 / 历史上限 / 搜索 / 命中判定」。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientSource = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')
const startMarker = '/* @region SELECTION_READER_STORE */'
const endMarker = '/* @endregion */'
const startIndex = clientSource.indexOf(startMarker)
const endIndex = clientSource.indexOf(endMarker, startIndex)
assert.ok(startIndex >= 0 && endIndex > startIndex, 'client.js 里找不到纯逻辑区域标记')
const region = clientSource.slice(startIndex + startMarker.length, endIndex)

const DEFAULT_PROMPT_STUB = '默认提示词'
const api = new Function(
  'DEFAULT_PROMPT',
  region +
    `
    return {
      recordKey,
      normalizeSettings,
      normalizeHistory,
      findCachedInterpretation,
      upsertInterpretation,
      removeInterpretation,
      searchInterpretations,
      hitRecord,
      parseInterpretation,
      splitTermText,
    }
  `,
)(DEFAULT_PROMPT_STUB)

let passed = 0
function test(name, fn) {
  fn()
  passed += 1
  console.log('ok - ' + name)
}

function record(overrides) {
  return {
    id: overrides.id || 'r-' + Math.random().toString(36).slice(2),
    text: 'SP-API',
    result: '这里是解释',
    sessionId: 's1',
    sessionTitle: '跨 LMS 集成讨论',
    nodeKey: 'node-1',
    turn: 1,
    start: 3,
    end: 9,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

test('设置项：缺省值、范围收敛与提示词回退', () => {
  const defaults = api.normalizeSettings(null)
  assert.equal(defaults.prompt, DEFAULT_PROMPT_STUB)
  assert.equal(defaults.modelMode, 'current')
  assert.equal(defaults.maxChars, 500)
  assert.equal(defaults.historyLimit, 200)
  assert.equal(defaults.entryEnabled, true)
  assert.equal(defaults.highlightStyle, 'fill')
  assert.equal(defaults.highlightColor, 'theme')
  const clamped = api.normalizeSettings({ maxChars: 5, historyLimit: 99999, highlightStyle: 'x', highlightColor: 'x' })
  assert.equal(clamped.maxChars, 50)
  assert.equal(clamped.historyLimit, 1000)
  assert.equal(clamped.highlightStyle, 'fill')
  assert.equal(clamped.highlightColor, 'theme')
  const emptyPrompt = api.normalizeSettings({ prompt: '   ' })
  assert.equal(emptyPrompt.prompt, DEFAULT_PROMPT_STUB)
  const custom = api.normalizeSettings({
    modelMode: 'custom',
    customBaseUrl: 'https://example.com/v1',
    customApiKey: 'sk-test',
    customModel: 'gpt-4o-mini',
  })
  assert.equal(custom.modelMode, 'custom')
  assert.equal(custom.customBaseUrl, 'https://example.com/v1')
  assert.equal(custom.customApiKey, 'sk-test')
  assert.equal(custom.customModel, 'gpt-4o-mini')
  assert.equal(api.normalizeSettings({ modelMode: 'weird' }).modelMode, 'current')
})

test('历史规范化：过滤无效项并按更新时间倒序', () => {
  const list = api.normalizeHistory([
    record({ id: 'a', updatedAt: 10 }),
    null,
    { sessionId: '', text: 'x', result: 'y' },
    { sessionId: 's2', text: '', result: 'y' },
    record({ id: 'b', updatedAt: 30 }),
  ])
  assert.equal(list.length, 2)
  assert.equal(list[0].id, 'b')
  assert.equal(list[1].id, 'a')
})

test('同一对话同一轮次：新内容覆盖旧内容，只留一条', () => {
  let list = []
  list = api.upsertInterpretation(list, record({ id: 'a', text: 'SP-API', turn: 4 }), 200)
  list = api.upsertInterpretation(list, record({ id: 'b', text: 'LGPD', turn: 4 }), 200)
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'b')
  assert.equal(list[0].text, 'LGPD')
})

test('不同轮次、不同对话各自保留', () => {
  let list = []
  list = api.upsertInterpretation(list, record({ id: 'a', turn: 1 }), 200)
  list = api.upsertInterpretation(list, record({ id: 'b', turn: 2 }), 200)
  list = api.upsertInterpretation(list, record({ id: 'c', sessionId: 's2', turn: 1 }), 200)
  assert.equal(list.length, 3)
})

test('缓存命中：同对话同轮次同文本直接复用；不同文本不复用', () => {
  const list = [record({ id: 'a', text: 'SP-API', turn: 4 })]
  assert.equal(api.findCachedInterpretation(list, 's1', 4, 'node-1', 'SP-API').id, 'a')
  assert.equal(api.findCachedInterpretation(list, 's1', 4, 'node-1', 'LGPD'), null)
  assert.equal(api.findCachedInterpretation(list, 's1', 5, 'node-1', 'SP-API'), null)
  assert.equal(api.findCachedInterpretation(list, 's2', 4, 'node-1', 'SP-API'), null)
})

test('历史条数上限：超出时删最旧记录', () => {
  let list = []
  for (let index = 0; index < 5; index += 1) {
    list = api.upsertInterpretation(list, record({ id: 'r' + index, turn: index, updatedAt: index * 10 }), 3)
  }
  assert.equal(list.length, 3)
  assert.deepEqual(
    list.map((item) => item.id),
    ['r4', 'r3', 'r2'],
  )
})

test('删除解读：按 id 移除记录', () => {
  const list = [record({ id: 'a' }), record({ id: 'b', turn: 2 })]
  const next = api.removeInterpretation(list, 'a')
  assert.equal(next.length, 1)
  assert.equal(next[0].id, 'b')
})

test('搜索：匹配解读文本与对话标题', () => {
  const list = [
    record({ id: 'a', text: 'SP-API', sessionTitle: '跨 LMS 集成讨论' }),
    record({ id: 'b', text: 'PIPL', sessionTitle: '平台政策核对' }),
  ]
  assert.deepEqual(
    api.searchInterpretations(list, 'sp-api').map((item) => item.id),
    ['a'],
  )
  assert.deepEqual(
    api.searchInterpretations(list, '政策').map((item) => item.id),
    ['b'],
  )
  assert.equal(api.searchInterpretations(list, '').length, 2)
})

test('高亮命中：同一节点内落在区间里才算命中', () => {
  const list = [record({ id: 'a', start: 10, end: 16, nodeKey: 'node-1' })]
  assert.equal(api.hitRecord(list, 's1', 'node-1', 10).id, 'a')
  assert.equal(api.hitRecord(list, 's1', 'node-1', 15).id, 'a')
  assert.equal(api.hitRecord(list, 's1', 'node-1', 16), null)
  assert.equal(api.hitRecord(list, 's1', 'node-2', 12), null)
  assert.equal(api.hitRecord(list, 's2', 'node-1', 12), null)
})

test('解读解析：识别「此处含义 / 依据 / 补充」三段', () => {
  const sections = api.parseInterpretation(
    '「此处含义」\nSP-API 是亚马逊卖家平台接口。\n\n「依据」\n对话提到 LGPD 与 PIPL。\n\n「补充」\n涉及数据合规。',
  )
  assert.deepEqual(
    sections.map((section) => section.label),
    ['此处含义', '依据', '补充'],
  )
  assert.equal(sections[0].body, 'SP-API 是亚马逊卖家平台接口。')
  assert.equal(sections[1].body, '对话提到 LGPD 与 PIPL。')
})

test('解读解析：兼容 Markdown 标题、加粗标题与行内标题', () => {
  const markdown = api.parseInterpretation('## 此处含义\n这是解释。\n\n**依据**：原文如此。')
  assert.deepEqual(
    markdown.map((section) => section.label),
    ['此处含义', '依据'],
  )
  assert.equal(markdown[1].body, '原文如此。')
  const inline = api.parseInterpretation('含义：一句话解释。\n补充: 一句备注。')
  assert.deepEqual(
    inline.map((section) => section.label),
    ['此处含义', '补充'],
  )
})

test('解读解析：没有小标题时退回整段，代码围栏被剥掉', () => {
  const plain = api.parseInterpretation('这就是一段没有小标题的解释。')
  assert.equal(plain.length, 1)
  assert.equal(plain[0].label, '')
  assert.equal(plain[0].body, '这就是一段没有小标题的解释。')
  const fenced = api.parseInterpretation('```text\n「补充」\n备注内容\n```')
  assert.equal(fenced.length, 1)
  assert.equal(fenced[0].label, '补充')
  assert.equal(fenced[0].body, '备注内容')
})

test('选中词切片：命中片段可高亮，空选中词不切分', () => {
  const pieces = api.splitTermText('SP-API 与 LGPD 的关系', 'LGPD')
  assert.deepEqual(
    pieces.map((piece) => [piece.text, piece.hit]),
    [
      ['SP-API 与 ', false],
      ['LGPD', true],
      [' 的关系', false],
    ],
  )
  assert.deepEqual(api.splitTermText('普通文本', ''), [{ text: '普通文本', hit: false }])
})

console.log('\n' + passed + ' tests passed')
