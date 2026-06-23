#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import vm from 'node:vm'

let registration
const styles = new Map()
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useMemo: fn => fn(),
  useState: initial => [initial, () => {}],
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}
vm.runInNewContext(readFileSync(new URL('../ui/plugins/@xlang/xharness-client-ui-profile/client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load: value => { registration = value } } },
  document: {
    getElementById: id => styles.get(id),
    createElement: () => ({ id: '', textContent: '', remove() {} }),
    head: { append: node => styles.set(node.id, node) },
  },
  Date, Math, Number, Object, String,
})
const bundle = readFileSync(new URL('../ui/plugins/@xlang/xharness-client-ui-profile/client.js', import.meta.url))
const graph = JSON.parse(readFileSync(new URL('../ui/dist/client-graph.json', import.meta.url)))
const entry = graph.entries.find(entry => entry.id === '@xlang/xharness-client-ui-profile')
assert.ok(entry, 'profile must be present in the shipped UI graph')
assert.equal(entry.rev, createHash('sha256').update(bundle).digest('hex').slice(0, 16))
assert.ok(readFileSync(new URL('../ui/dist/index.html', import.meta.url), 'utf8').includes(entry.id))
assert.equal(registration.id, '@xlang/xharness-client-ui-profile')
const plugin = registration.factory(name => {
  assert.equal(name, 'react')
  return React
})
assert.deepEqual([...plugin.inject], ['slots', 'sessions', 'locale'])

const day = Date.UTC(2026, 8, 25)
const previous = Date.UTC(2026, 8, 24)
const usage = (dayStartMs, input, cacheRead = 0, cacheWrite = 0, output = 0) => ({
  dayStartMs, uncachedInputTokens: input, cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite, outputTokens: output,
})
const rows = [
  { id: 'a', projectionValues: { dailyTokenUsage: [usage(previous, 10, 0, 0, 1), usage(day, 100, 300, 0, 20)] } },
  { id: 'b', projectionValues: { dailyTokenUsage: [usage(day, 50, 0, 10, 5)] } },
  { id: 'blank', blank: true, projectionValues: { dailyTokenUsage: [usage(day, 999)] } },
  { id: 'missing', projectionValues: { tokenUsage: { uncachedInputTokens: 999 } } },
]
const result = plugin.summarize(rows)
assert.equal(result.total, 496)
assert.equal(result.peak, 485)
assert.equal(result.daily.get('2026-09-24'), 11)
assert.equal(result.daily.get('2026-09-25'), 485)
assert.equal(result.activeDays, 2)
assert.equal(result.chats, 3)
assert.equal(result.measured, 2)
assert.equal(result.buckets.cacheRead, 300)
const currentWindow = plugin.calendar(new Date(2026, 8, 25))
const previousWindow = plugin.calendar(new Date(2026, 8, 25), 1)
assert.equal(currentWindow.length, 26)
assert.equal(currentWindow.flat().length, 182)
assert.equal(previousWindow.length, 26)
assert.equal(previousWindow.at(-1).at(-1).key < currentWindow[0][0].key, true)
const dayAfterPrevious = new Date(previousWindow.at(-1).at(-1).date)
dayAfterPrevious.setUTCDate(dayAfterPrevious.getUTCDate() + 1)
assert.equal(dayAfterPrevious.getTime(), currentWindow[0][0].date.getTime())
assert.equal(plugin.summarize([{id:'bad',projectionValues:{dailyTokenUsage:[usage(day + 1, -1, 0, 0, Infinity)]}}]).total, 0)

const sections = []
const dictionary = { en: null, zh: null }
plugin.apply({
  effect: fn => { fn() },
  locale: {
    register: (_ns, dictionaries) => { dictionary.en = dictionaries.en; dictionary.zh = dictionaries.zh; return () => {} },
    bind: () => key => dictionary.en[key],
  },
  sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({phase:'ready',byId:Object.fromEntries(rows.map(r=>[r.id,r]))}) } },
  slots: { inject: (_name, fn) => fn(), register: (options, component) => { sections.push({options,component}); return () => {} } },
})
assert.equal(sections.length, 1)
assert.equal(sections[0].options.name, 'settings.section')
assert.equal(sections[0].options.id, 'profile')
assert.equal(sections[0].options.order, 30)
assert.equal(sections[0].options.label(), 'Profile')
assert.ok(dictionary.zh.nav)
assert.ok(styles.get('xharness-profile-style'))
const props = sections[0].options.inject()
const view = sections[0].component(props)
function text(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(text).join(' ')
  return node?.children?.map(text).join(' ') ?? ''
}
assert.match(text(view), /Usage profile/)
assert.match(text(view), /496/)
assert.match(text(view), /485/)
assert.doesNotMatch(text(view), /Provider-reported tokens|UTC event day|Session list is not ready/)
assert.doesNotMatch(text(view), /NaN|Infinity/)
function find(node, predicate) {
  if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean)
  if (!node || typeof node !== 'object') return undefined
  return predicate(node) ? node : find(node.children, predicate)
}
const dayGrid = find(view, node => node.props?.className === 'xhp-weeks')
assert.equal(find(view, node => node.props?.className === 'xhp-method'), undefined, 'implementation note is not a UI element')
assert.equal(dayGrid.children[0].length, 26)
const period = find(view, node => node.props?.className === 'xhp-period')
assert.equal(period.children[0].length, 3)
assert.equal(period.children[0][0].props.disabled, true)
assert.equal(period.children[0][2].props.disabled, true)

const older = { id: 'historical', updatedAt: new Date(2020, 0, 1).getTime(),
  projectionValues: { dailyTokenUsage: [usage(Date.UTC(2020, 0, 1), 12)] } }
const historicalView = sections[0].component({
  ...props,
  list: { subscribe: () => () => {}, getSnapshot: () => ({ phase: 'ready', byId: { historical: older } }) },
})
const historicalPeriod = find(historicalView, node => node.props?.className === 'xhp-period')
assert.equal(historicalPeriod.children[0][0].props.disabled, false)
assert.equal(historicalPeriod.children[0][2].props.disabled, true)
console.log('profile settings plugin tests passed')
