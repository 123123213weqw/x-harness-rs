// Regression of canonical shipped breadcrumb and navigation implementations.
// The seam exposes complete emitted units: no copied Header, partial Navigation
// class, replacement HistoryCache, or stubbed production manager method.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'
import { sourceDeclaration } from './fixtures/source-declaration.mjs'
import { assertRebuildInput } from './fixtures/repository-ui-input.mjs'

const dist = resolve(process.env.UI_TEST_DIST ?? new URL('../ui/dist/', import.meta.url).pathname)
const dependencies = process.env.UI_TEST_DEPS ?? '/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps'
const graph = JSON.parse(readFileSync(resolve(dist, 'client-graph.json'), 'utf8'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 16)
assert.equal(graph.rev, hash(Buffer.from(JSON.stringify(graph.entries))))
function shipped(id, root) {
  const bytes = readFileSync(resolve(dist, 'plugins', id, 'client.js'))
  const entry = graph.entries.find(row => row.id === id)
  assert.ok(entry, `canonical graph includes ${id}`)
  assert.equal(entry.rev, hash(bytes), 'browser input matches the shipped ModuleLoader graph revision')
  assert.ok(bytes.toString().startsWith(`// Generated from src/modules/${root}/`))
  assert.equal(assertRebuildInput(id).kind, 'source-module', 'shipped bytes match complete strict repository source closure')
  return bytes.toString()
}
const conversation = shipped('@xharness/dsh-client-ui-conversation', 'conversation')
const runtime = shipped('@xharness/dsh-client-runtime', 'client-runtime')
// AST addresses the declaration instead of old emitter whitespace/end markers.
const ancestry = sourceDeclaration(conversation, 'deriveAncestry')
sourceDeclaration(conversation, 'ConversationSessionHeader')
assert.match(sourceDeclaration(runtime, 'SessionManager'), /this\.historyCache\(\)\.touch\(this\.selected\)/,
  'actual manager retains the native history-residency selection integration')
const derive = vm.runInNewContext(`${ancestry}; deriveAncestry`)
const ids = list => Array.from(derive(list, 'child'), item => item.id)
const broken = { byId: {
  parent: { id: 'parent', displayTitle: '主 Agent' },
  child: { id: 'child', displayTitle: '子 Agent', parentId: 'parent' },
} }
assert.deepEqual(ids(broken), ['child'], 'reproduce missing-origin regression: only disabled current breadcrumb')
const fixed = structuredClone(broken)
fixed.byId.child.origin = 'subagent'
assert.deepEqual(ids(fixed), ['parent', 'child'])
const cycle = structuredClone(fixed)
cycle.byId.parent = { ...cycle.byId.parent, origin: 'subagent', parentId: 'child' }
assert.deepEqual(ids(cycle), ['parent', 'child'])
const missing = structuredClone(fixed)
delete missing.byId.parent
assert.deepEqual(ids(missing), ['child'])
const fork = structuredClone(fixed)
fork.byId.child.origin = 'fork'
assert.deepEqual(ids(fork), ['parent', 'child'], 'fork ancestry uses the same native parent navigation')
assert.deepEqual(Array.from(derive(fixed, 'unknown')), [])

// Only redirect the owned bundler's terminal return. Its complete unit functions
// and transitive production dependencies remain untouched, and entry apply/Host
// startup is deliberately not invoked by this isolated browser fixture.
function internalsOnly(source) {
  const terminal = /return __load\(("[^"\n]+")\);\n\}\n\}\);\s*$/
  assert.ok(terminal.test(source), 'test seam addresses the source bundler terminal return')
  return source.replace(terminal, 'return { internal: __load };\n}\n});')
}
const require = createRequire(resolve(dependencies, 'package.json'))
const { chromium, webkit } = require('playwright')
const engine = process.env.UI_TEST_BROWSER ?? 'chromium'
const browser = await ({ chromium, webkit })[engine].launch({ headless: true })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setContent('<div id="header"></div><textarea aria-label="消息"></textarea>')
  for (const file of ['react/umd/react.development.js', 'react-dom/umd/react-dom.development.js']) {
    await page.addScriptTag({ path: resolve(dependencies, 'node_modules', file) })
  }
  await page.addScriptTag({ content: 'window.__registrations = {}; window.__ModuleLoader__ = { load: row => { window.__registrations[row.id] = row } };' })
  await page.addScriptTag({ content: internalsOnly(conversation) })
  await page.addScriptTag({ content: internalsOnly(runtime) })
  await page.evaluate(() => {
    const external = id => {
      if (id === 'react') return React
      if (id === 'react/jsx-runtime') {
        const jsx = (type, props, key) => React.createElement(type, key === undefined ? props : { ...props, key })
        return { jsx, jsxs: jsx, Fragment: React.Fragment }
      }
      throw Error(`unexpected native navigation closure dependency: ${id}`)
    }
    const { ConversationSessionHeader } = window.__registrations['@xharness/dsh-client-ui-conversation']
      .factory(external).internal('src/modules/conversation/skeleton/ConversationSession.js')
    const { SessionManager } = window.__registrations['@xharness/dsh-client-runtime']
      .factory(external).internal('src/modules/client-runtime/sessions/manager.js')
    window.__catalogReads = []
    const catalog = { parentAvailable: true, entries: [{
      kind: 'child', id: 'child', title: '子 Agent', mode: 'continuable', activity: 'running', hasChildren: false,
    }] }
    const api = {
      sessions: { history: async () => ({ result: { ok: true, value: { entries: [], hasMore: false, baseSeq: 0 } } }) },
      subagents: { list: async ({ parentSessionId }) => {
        window.__catalogReads.push(parentSessionId)
        return { result: { ok: true, value: parentSessionId === 'parent' ? structuredClone(catalog) : { parentAvailable: true, entries: [] } } }
      } },
    }
    const childAddress = { parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable' }
    window.manager = new SessionManager(api, { commands: { execute: async () => ({ result: { ok: true, value: null } }) } }, 'child', childAddress)
    // Wire-level fixture state; the real constructor initializes all Maps,
    // Notifier/snapshot caches and HistoryCache dependencies itself.
    manager.summaries = [
      { sessionId: 'parent', title: '主 Agent', updatedAt: 2, running: false, blank: false },
      { sessionId: 'child', title: '子 Agent', updatedAt: 1, running: true, blank: false, origin: 'subagent', parentSessionId: 'parent' },
    ]
    window.parentSession = manager.get('parent')
    window.childSession = manager.get('child')
    manager.completedNotifications.add('parent')
    window.root = ReactDOM.createRoot(document.getElementById('header'))
    const views = { subscribe: () => () => {}, version: () => 0, list: () => [{ id: 'chat', label: 'Chat' }] }
    window.render = () => {
      const id = manager.getListSnapshot().current
      const session = manager.get(id)
      const list = { byId: Object.fromEntries(manager.getListSnapshot().items.map(item => [item.sessionId, {
        id: item.sessionId, displayTitle: item.title ?? item.sessionId, parentId: item.parentSessionId, origin: item.origin,
      }])) }
      document.querySelector('textarea').dataset.target = id
      root.render(React.createElement(ConversationSessionHeader, {
        sessionId: id,
        useSession: select => select(session.getSnapshot()),
        useSessions: select => select(list),
        useStore: select => select({ view: 'chat' }),
        actions: { setView() {} }, renderSlot: () => null,
        views, open: next => manager.select(next), t: key => key,
      }))
    }
    window.__unsubscribeNavigation = manager.subscribe(() => render())
    manager.select('child')
  })
  const parent = page.getByRole('button', { name: '主 Agent', exact: true })
  await parent.waitFor()
  assert.equal(await parent.isEnabled(), true)
  assert.equal(await page.getByRole('button', { name: '子 Agent', exact: true }).isDisabled(), true)
  const historyClock = await page.evaluate(() => manager.xhHistoryCache.clock)
  await parent.click()
  assert.equal(await page.evaluate(() => manager.selected), 'parent')
  assert.equal(await page.locator('textarea').getAttribute('data-target'), 'parent')
  assert.equal(await page.evaluate(() => manager.navigationAddress('parent')), undefined, 'parent must not retain child transport address')
  assert.equal(await page.evaluate(() => parentSession.address), undefined, 'actual parent Session stays on ordinary transport')
  assert.equal(await page.evaluate(() => manager.completedNotifications.has('parent')), false, 'native selection consumes completion reminder')
  assert.ok(await page.evaluate(() => manager.xhHistoryCache.clock) > historyClock, 'real history cache is touched by native select')
  assert.equal(await page.evaluate(() => childSession.getSnapshot().running), true, 'parent navigation does not interrupt a running child')
  assert.deepEqual(await page.evaluate(() => manager.navigationAddress('child')), {
    parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable',
  })
  // Repeat child -> parent via keyboard, preserving editable main composer even
  // when the retained child transport is still running off screen.
  await page.evaluate(() => manager.select('child'))
  await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some(button => button.textContent === '主 Agent' && !button.disabled))
  await parent.focus()
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => manager.selected === 'parent')
  assert.equal(await page.evaluate(() => manager.getListSnapshot().current), 'parent')
  await page.locator('textarea').fill('继续主任务')
  assert.equal(await page.locator('textarea').inputValue(), '继续主任务')
  // Restored wire summaries after reconnect still flow through the real manager
  // snapshot and the same complete Header unit, not a locally copied function.
  await page.evaluate(() => {
    manager.summaries = structuredClone(manager.summaries)
    manager.select('child')
  })
  await parent.click()
  assert.equal(await page.evaluate(() => manager.selected), 'parent')
  // Catalog-discovered address resolution must work even without a retained
  // child address. Ordinary parent selection still cannot gain that authority.
  await page.evaluate(async () => {
    manager.addresses.delete('child')
    await manager.refreshSubagents('parent')
    manager.select('child')
  })
  assert.deepEqual(await page.evaluate(() => manager.subagentAddress('child')), {
    parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable',
  })
  await parent.click()
  assert.equal(await page.evaluate(() => manager.navigationAddress('parent')), undefined)
  assert.match(await page.evaluate(() => {
    try { manager.select('unknown'); return 'unexpected success' } catch (error) { return error.message }
  }), /unknown session unknown/)
  assert.equal(await page.evaluate(() => manager.selected), 'parent', 'failed navigation leaves current parent selection intact')
  assert.equal(await page.evaluate(() => manager.xhHistoryCache.manager === manager), true)
  assert.equal(await page.evaluate(() => manager.sessions.get('parent') === parentSession && manager.sessions.get('child') === childSession), true)
  assert.ok((await page.evaluate(() => window.__catalogReads)).includes('parent'), 'real refreshSubagents closure reaches the controlled Host API fixture')
  await page.evaluate(() => { window.__unsubscribeNavigation(); root.unmount() })
  assert.deepEqual(errors, [], 'canonical Header and SessionManager closures must not emit browser exceptions')
  console.log(`${engine}: canonical source ancestry missing-origin/cycle/orphan/fork; native Header click/keyboard/reconnect and full SessionManager transport/catalog/completion/history-cache closure passed; browser errors []`)
} finally {
  await browser.close()
}
