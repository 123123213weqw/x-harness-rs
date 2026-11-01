import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { installOwnedViewPlatform } from './fixtures/owned-view-platform-browser.mjs'
import { compileSourceModules } from './build-source-modules.mjs'
import { runtimeTestSource } from './runtime-source-test-harness.mjs'

const require = createRequire(resolve(process.env.UI_TEST_DEPS ?? '/tmp/ui-tests', 'package.json'))
const engine = process.env.UI_TEST_BROWSER ?? 'chromium'
const browser = await require('playwright')[engine].launch({ headless: true })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => { if (!error.message.includes('stop Host boot')) errors.push(error.message) })
  await installOwnedViewPlatform(page, 'source')
  await page.evaluate(() => { window.registrations = {}; window.__ModuleLoader__ = { load: row => { registrations[row.id] = row } } })
  const dist = resolve(process.env.UI_TEST_DIST ?? 'ui/dist', 'plugins/@xharness')
  for (const name of readdirSync(dist)) {
    const source = name === 'dsh-client-runtime' ? runtimeTestSource() : readFileSync(resolve(dist, name, 'client.js'), 'utf8')
    await page.addScriptTag({ content: source })
  }
  const sidebarId = 'new-session-test:sidebar'
  const sidebar = compileSourceModules(resolve('ui'), [{ id: sidebarId, source: 'src/modules/sidebar/SidebarRoot.tsx' }]).get(sidebarId)
  await page.addScriptTag({ content: sidebar.bytes.toString() })
  await page.evaluate(async sidebarId => {
    const loaded = {}
    function load(id) { return staticModules[id] ?? (loaded[id] ??= registrations[id]?.factory(load) ?? registrations[id.replace(/\/client$/, '')].factory(load)) }
    const { SessionManager, WorkspaceRuntime } = load('@xharness/dsh-client-runtime')
    const { SidebarRoot } = load(sidebarId)
    const reply = value => ({ result: { ok: true, value } })
    window.calls = []
    const api = { sessions: {
      list: async () => reply({ items: [
        { sessionId: 'old', blank: true, running: false, cwd: '/workspace', updatedAt: 1 },
        { sessionId: 'working', blank: false, running: true, cwd: '/workspace', updatedAt: 2 },
      ] }),
      create: async payload => { calls.push(payload); return reply({ sessionId: 'fresh' }) },
    } }
    const manager = window.manager = new SessionManager(api, {})
    const sessions = {
      list: {
        subscribe: fn => manager.subscribe(fn),
        getSnapshot: () => {
          const { items, current, phase } = manager.getListSnapshot()
          return { ids: items.map(row => row.sessionId), byId: Object.fromEntries(items.map(row => [row.sessionId, { ...row, id: row.sessionId }])), current, phase }
        },
      },
      create: async opts => { const result = await manager.create(opts); if (!result.ok) throw Error('fixture create failed'); return result.value.sessionId },
      open: id => manager.select(id), clear: () => manager.clearSelection(),
    }
    const workspace = new WorkspaceRuntime({ reflect: { provide() {} } }, api, sessions)
    workspace.handleHostEnvelope({ rpcId: 'workspace', payload: { type: 'host/workspace-changed', workspace: {
      workspaceId: 'w', path: '/workspace', title: 'Workspace', sessionIds: ['old', 'working'], createdAt: '1', updatedAt: '1',
    } } })
    await manager.refreshList(); manager.select('old')
    manager.handleMuxEnvelope({ rpcId: 'recovered', payload: { type: 'session/projection', sessionId: 'old', key: 'sessionListMetadata', seq: 20, value: { blank: false, restoring: false, lastPromptAt: 1 } } })
    function App() {
      const state = React.useSyncExternalStore(fn => manager.subscribe(fn), () => manager.getListSnapshot())
      return React.createElement(React.Fragment, null,
        React.createElement(SidebarRoot, { collapsed: false, width: 280, startSession: () => workspace.startSession('w'), toggleSidebar() {}, t: key => ({ 'session.new.label': 'New session', 'session.new': 'New session' }[key] ?? key), renderSlot: (_key, _owner, options) => options?.fallback ?? null }),
        React.createElement('output', { 'aria-label': 'Selected session' }, state.current),
        React.createElement('textarea', { 'aria-label': 'Message', defaultValue: '' }))
    }
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App))
  }, sidebarId)
  const selected = page.getByRole('status', { name: 'Selected session' })
  await selected.waitFor(); assert.equal(await selected.innerText(), 'old')
  await page.getByRole('button', { name: 'New session', exact: true }).last().click()
  await page.waitForFunction(() => manager.getListSnapshot().current === 'fresh')
  assert.equal(await selected.innerText(), 'fresh')
  assert.equal(await page.evaluate(() => calls.length), 1)
  assert.equal(await page.evaluate(() => manager.getListSnapshot().items.find(row => row.sessionId === 'old').blank), false)
  assert.equal(await page.evaluate(() => manager.getListSnapshot().items.find(row => row.sessionId === 'working').running), true)
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('New task stays in the fresh session')
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'New task stays in the fresh session')
  assert.deepEqual(errors, [])
  console.log(`${engine}: real sidebar + SessionManager + WorkspaceRuntime opens a fresh session without interrupting other work`)
} finally { await browser.close() }
