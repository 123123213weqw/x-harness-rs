import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import { compileSourceModules } from './build-source-modules.mjs'

const output = compileSourceModules(new URL('../ui', import.meta.url).pathname, [
  { id: 'account-entry-test', source: 'src/modules/settings-general/AccountEntry.tsx' },
  { id: 'account-labels-test', source: 'src/modules/settings-general/locales.ts' },
])
const react = { useState: value => [value, () => {}], useRef: value => ({ current: value }),
  useEffect() {}, useCallback: value => value }
const jsx = (type, props) => ({ type, props })
function load(id) {
  let registration
  vm.runInNewContext(output.get(id).bytes.toString(), { console,
    window: { __ModuleLoader__: { load: value => registration = value }, __TAURI__: { core: { invoke() { throw Error('must not authenticate from this entry') } } } },
    document: { querySelector: () => null, createElement: () => ({ dataset: {} }), head: { appendChild() {} } },
  })
  return registration.factory(name => {
    if (name === 'react') return react
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
    if (name === '@xharness/dsh-client-ui-primitives') return new Proxy({}, { get: (_target, key) => key })
    throw Error(`Unexpected feature dependency: ${name}`)
  })
}
const { AccountEntry, accountMenuRows } = load('account-entry-test')
const { zh, en } = load('account-labels-test')
const plain = value => JSON.parse(JSON.stringify(value))
const rows = ['general', 'profile', 'managed-account'].map(id => ({ id, label: 'wrong translated label', order: 0 }))

test('bilingual menu routes by IDs, independently of row labels/order', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  for (const dict of [zh, en]) {
    const items = accountMenuRows(rows, key => dict[key])
    assert.deepEqual(plain(items.map(row => row.id)), ['managed-account', 'profile', 'general'])
    assert.ok(items.every(item => item.label && item.label !== 'wrong translated label'))
  }
})
test('optional account/profile features disappear; local Settings needs no login', () => {
  assert.deepEqual(plain(accountMenuRows([rows[0]], key => en[key]).map(row => row.id)), ['general'])
  assert.deepEqual(plain(accountMenuRows([], key => en[key])), [])
})
test('wide and rail share one accessible trigger and real menu routing; no inferred identity or fake balance', () => {
  for (const wide of [true, false]) for (const dict of [zh, en]) {
    const selections = []
    const view = AccountEntry({ wide, rows, t: key => dict[key], openSection: id => selections.push(id) })
    const menu = view.props.children.props
    assert.equal(menu.portal, true)
    assert.equal(menu.side, 'top')
    assert.equal(menu.anchor.props['aria-label'], dict['account.trigger'])
    assert.equal(menu.anchor.props['aria-haspopup'], 'menu')
    assert.equal(menu.anchor.props['aria-expanded'], false)
    assert.equal(menu.items[0].text, dict['account.local'])
    for (const id of ['managed-account', 'profile', 'general', 'unknown']) menu.onSelect(id)
    assert.deepEqual(selections, ['managed-account', 'profile', 'general'])
    assert.equal(JSON.stringify(view).includes('accessToken'), false)
  }
})
