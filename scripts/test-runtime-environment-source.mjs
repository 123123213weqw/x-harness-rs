import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { compileSourceModules } from './build-source-modules.mjs'
import { harness } from './conversation-test-harness.mjs'

const id = '@xlang/xharness-client-ui-runtime'
const rows = [
  { id, source: 'src/modules/runtime-environment/index.ts' },
  { id: id + '/test', source: 'src/modules/runtime-environment/test-exports.ts' },
  { id: 'conversation/test', source: 'src/modules/conversation/test-exports.ts' },
]
const built = compileSourceModules(new URL('../ui', import.meta.url).pathname, rows)
const create = (react = {}) => harness(built.get(id + '/test').bytes.toString(), { react: { useEffect() {}, ...react } }).plugin
const api = create()
const appearance = { trigger: 'workspace-trigger', icon: 'workspace-icon', label: 'workspace-label', chevron: 'workspace-chevron' }
const draft = { sessionId: 's', summaryBlank: true, composerPhase: 'blank', openState: 'cold', appearance }

test('all 120 composer/history combinations fail closed except confirmed blank cold/open', () => {
  let count = 0
  for (const sessionId of [undefined, 's']) for (const summaryBlank of [undefined, false, true])
    for (const composerPhase of [undefined, 'blank', 'engaging', 'active'])
      for (const openState of [undefined, 'cold', 'loading', 'open', 'error']) {
        const actual = api.environmentPresentation({ sessionId, summaryBlank, composerPhase, openState })
        const expected = sessionId === undefined || (summaryBlank === true && composerPhase === 'blank' && ['cold', 'open'].includes(openState))
          ? 'draft' : openState === 'open' && composerPhase === 'active' ? 'bound' : 'unknown'
        assert.equal(actual, expected)
        for (const id of ['local', 'cloud', 'vm-1', '', '__proto__']) assert.equal(api.canAcknowledgeLocalPick(actual, id), expected === 'draft' && id === 'local')
        count++
      }
  assert.equal(count, 120)
})

test('menus remain inspectable when locked, unknown, or cloud unavailable', () => {
  for (const facts of [draft, { ...draft, composerPhase: 'active', openState: 'open' }, { ...draft, openState: 'error' }]) {
    const menu = api.EnvironmentPicker({ ...facts, t: k => api.en[k] })
    assert.equal(menu.props.anchor.props.disabled, undefined)
    assert.equal(menu.props.anchor.props['aria-haspopup'], 'menu')
    assert.equal(menu.props.items.find(item => item.id === 'cloud').disabled, true)
    assert.equal(menu.props.items.find(item => item.id === 'local').disabled, api.environmentPresentation(facts) !== 'draft')
    assert.equal(menu.props.portal, true)
    assert.equal(menu.props.anchor.props.className, appearance.trigger)
    assert.equal(menu.props.anchor.props.children[0].props.className, appearance.icon)
    assert.equal(menu.props.anchor.props.children[0].props.size, 16)
    assert.equal(menu.props.anchor.props.children[0].props['aria-hidden'], 'true')
    assert.equal(menu.props.anchor.props.children[1].props.className, appearance.label)
    assert.equal(menu.props.anchor.props.children[2].props.className, appearance.chevron)
  }
})

test('the actual resident owner supplies current-session facts and shared workspace styles', () => {
  const conversation = harness(built.get('conversation/test').bytes.toString(), { react: { useEffect() {} } }).plugin
  for (const facts of [draft, { ...draft, sessionId: undefined }, { ...draft, openState: 'loading' }, { ...draft, composerPhase: 'active', openState: 'open' }]) {
    const shares = []
    conversation.ConversationRoot({
      sessionId: facts.sessionId,
      useSession: select => select({ openState: facts.openState, composerPhase: facts.composerPhase, pending: [] }),
      useSessions: select => select({ byId: { s: { blank: facts.summaryBlank, cwd: '/fixture' } } }),
      useWorkspaces: select => select({ items: [], phase: 'ready' }),
      useInput: select => select({}), useComposerBlock: () => undefined,
      t: key => key, selectWorkspace: async () => {},
      renderSlot: (name, owner) => { shares.push({ name, owner }); return null },
      renderSlotChain: (_name, _owner, options) => options.fallback,
    })
    const shared = shares.find(row => row.name === 'conversation.hero.runtimeEnvironment').owner
    assert.equal(shared.sessionId, facts.sessionId)
    assert.equal(shared.openState, facts.openState)
    assert.equal(shared.composerPhase, facts.composerPhase)
    assert.equal(shared.summaryBlank, facts.sessionId === undefined ? undefined : facts.summaryBlank)
    assert.deepEqual(Object.keys(shared.appearance).sort(), ['chevron', 'icon', 'label', 'trigger'])
    assert.equal(shared.appearance.trigger, '_f60Wq_workspace')
  }
})

test('forged cloud/unknown selection cannot change execution or acknowledge a pick', () => {
  const updates = [], api = create({ useState: () => [false, next => updates.push(next)] })
  const menu = api.EnvironmentPicker({ ...draft, t: k => api.en[k] })
  for (const id of ['cloud', 'vm-1', 'unknown', '__proto__']) menu.props.onSelect(id)
  assert.deepEqual(updates, [])
  menu.props.onSelect('local')
  assert.deepEqual(updates, [false])
  const locked = api.EnvironmentPicker({ ...draft, openState: 'error', t: k => api.en[k] })
  locked.props.onSelect('local')
  assert.deepEqual(updates, [false])
})

test('locale and slot registrations return their cleanup handles', () => {
  const calls = [], cleanups = []
  api.apply({
    effect: (fn, label) => { calls.push(['effect', label]); cleanups.push(fn()) },
    locale: { register: (ns, dictionaries) => { calls.push(['locale', ns, dictionaries]); return () => calls.push(['locale-disposed']) } },
    slots: {
      inject: (name, fn) => { calls.push(['inject', name]); cleanups.push(fn()) },
      register: (spec, component) => { calls.push(['register', spec, component]); return () => calls.push(['slot-disposed']) },
    },
  })
  assert.deepEqual(JSON.parse(JSON.stringify(api.inject)), ['slots', 'locale'])
  assert.equal(calls.find(row => row[0] === 'register')[1].name, 'conversation.hero.runtimeEnvironment')
  assert.equal(calls.find(row => row[0] === 'register')[1].locale, api.NS)
  assert.equal(cleanups.length, 2)
  for (const dispose of cleanups) { assert.equal(typeof dispose, 'function'); dispose() }
  assert.equal(calls.filter(row => row[0].endsWith('disposed')).length, 2)
})

test('bilingual copy explicitly states cloud unavailable without exposing machine names', () => {
  assert.deepEqual(Object.keys(api.en).sort(), Object.keys(api.zh).sort())
  assert.equal(api.en.cloud, 'Cloud'); assert.equal(api.zh.cloud, 'Cloud')
  assert.match(api.en.unavailable, /not connected/); assert.match(api.zh.unavailable, /尚未接入/)
  assert.match(api.en.unknown, /not been confirmed/)
  for (const dict of [api.en, api.zh]) assert.doesNotMatch(JSON.stringify(dict), /V100|WZU|4080|192\.168\./)
})

test('production graph admits the owned TS picker, not its private test entry or old bundle patch', () => {
  const spec = JSON.parse(readFileSync('ui/modules.json', 'utf8'))
  const row = spec.modules.find(row => row.id === id)
  assert.equal(row.kind, 'source-module')
  assert.equal(row.source, rows[0].source)
  assert.deepEqual(row.inject, ['@xharness/dsh-client-ui-conversation', '@xharness/dsh-client-locale'])
  assert.ok(!spec.modules.some(row => row.source?.endsWith('/runtime-environment/test-exports.ts')))
  const root = readFileSync('ui/src/modules/conversation/skeleton/ConversationRoot.tsx', 'utf8')
  assert.match(root, /renderSlot\('conversation\.hero\.runtimeEnvironment'/)
  assert.match(root, /trigger: heroCss\.workspace/)
  assert.match(readFileSync('ui/src/modules/conversation/apply.ts', 'utf8'), /'conversation\.hero\.runtimeEnvironment': \{ kind: 'single', scope: 'root' \}/)
  const graph = JSON.parse(readFileSync('ui/dist/client-graph.json', 'utf8'))
  assert.equal(graph.entries.filter(row => row.id === id).length, 1)
  assert.ok(built.get(id).sources.every(source => !source.startsWith('reference/') && !source.startsWith('legacy/')))
})
