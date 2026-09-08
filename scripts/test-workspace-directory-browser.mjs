// Actual shipped React, primitives, workspace owner and product flow; only the
// host services/slot harness are fixtures. No running App or user data is used.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const dist = resolve(root, 'ui/dist')
const require = createRequire(resolve(process.env.UI_TEST_DEPS ?? '/tmp/ui-tests', 'package.json'))
const engines = require('playwright')
const engine = process.env.UI_TEST_BROWSER ?? 'chromium'
const browser = await engines[engine].launch({ headless: true,
  ...(process.env.UI_TEST_EXECUTABLE ? { executablePath: process.env.UI_TEST_EXECUTABLE } : {}) })
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.setDefaultTimeout(8000)
  const assets = readdirSync(resolve(dist, 'assets'))
  const entry = assets.find(name => /^index-.*\.js$/.test(name))
  const css = assets.filter(name => name.endsWith('.css'))
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    const name = url.pathname.slice('/assets/'.length)
    if (url.pathname.startsWith('/assets/') && assets.includes(name)) {
      return route.fulfill({ body: readFileSync(resolve(dist, 'assets', name)),
        contentType: name.endsWith('.css') ? 'text/css' : 'application/javascript' })
    }
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head>
      ${css.map(name => `<link rel="stylesheet" href="/assets/${name}">`).join('')}
      <script>window.__ModuleLoader__={create: options => {window.staticModules=options.staticModules;throw Error('isolated fixture: stop host boot')}};</script>
      <script type="module" src="/assets/${entry}"></script></head><body><div id="root"></div></body></html>` })
    return route.abort()
  })
  await page.goto('http://workspace-fixture.test/')
  await page.waitForFunction(() => window.staticModules)
  await page.evaluate(() => { document.getElementById('root').replaceChildren(); window.registrations = {}; window.__ModuleLoader__ = { load: reg => { registrations[reg.id] = reg } } })
  for (const id of ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme', '@deepseek-ai/dsh-client-ui-workspace', '@xlang/xharness-client-ui-directory']) {
    await page.addScriptTag({ content: readFileSync(resolve(dist, `plugins/${id}/client.js`), 'utf8') })
  }
  await page.evaluate(() => {
    const React = staticModules.react
    const ReactDOM = staticModules['react-dom']
    const h = React.createElement
    const slotMap = new Map(), dictionaries = new Map()
    const runtime = registrations['@deepseek-ai/dsh-client-runtime'].factory(id => staticModules[id])
    const readModule = id => id === '@deepseek-ai/dsh-client-runtime/client' ? { ...runtime, defineStore: spec => spec } : staticModules[id]
    window.base = 'D:\\工作区'
    window.paths = new Map([[base, ['已有项目', '.hidden']], [base + '\\已有项目', []], [base + '\\.hidden', []], ['C:\\', ['Users']], ['D:\\', ['工作区']], ['\\\\server\\share', []], ['/tmp/projects', []]])
    window.drives = ['C:\\', 'D:\\', 'Z:\\'] // Assigned but unavailable Z: must still be visible.
    window.oldHost = false
    window.calls = { lists: [], creates: [], adopts: [], picks: [], aborts: 0 }
    window.pending = {}; window.blockRead = null; window.failCreate = false; window.blockCreate = false; window.failAdopt = false
    const listing = path => path === ''
      ? { path: '', home: base, entries: drives.map(path => ({ name: path, path, hidden: false })), crumbs: [], truncated: false }
      : ({ path, home: base, entries: (paths.get(path) ?? []).map(name => ({ name, path: path + (path.endsWith('\\') ? '' : '\\') + name, hidden: name.startsWith('.') })),
      crumbs: [{ name: path, path, hidden: false }], truncated: false })
    const workspaceSnapshot = { items: [], phase: 'ready', archivedSessionIds: [], state: 'idle' }
    const workspaces = {
      async listDirectory(path = base, signal) {
        calls.lists.push(path)
        signal?.addEventListener('abort', () => calls.aborts++, { once: true })
        if (path === blockRead) return new Promise(resolve => { pending.read = () => resolve(listing(path)) })
        if (path === '' && !oldHost) return listing(path)
        if (!paths.has(path)) throw { rpcError: { message: 'Cannot read directory (access denied or missing)' } }
        return listing(path)
      },
      async createDirectory(path, name) {
        calls.creates.push({ path, name })
        if (blockCreate) await new Promise(resolve => { pending.create = resolve })
        if (failCreate || paths.get(path).includes(name)) throw { rpcError: { message: 'Folder exists or permission denied' } }
        const created = path + '\\' + name
        paths.get(path).push(name); paths.set(created, [])
        return created
      },
      async create(input) {
        calls.adopts.push(input)
        if (failAdopt) throw Error('Workspace registration failed')
        return { workspaceId: input.path }
      },
      startSession: id => calls.picks.push(id),
    }
    const ctx = {
      effect: fn => fn(),
      provide: (name, value) => { ctx[name] = value }, on: () => {}, emit: () => {},
      settingsScope: { bind: () => ({ subscribe: () => () => {}, getSnapshot: () => ({ value: { preference: 'light' } }) }) },
      get: () => ({ hostDescription: { getSnapshot: () => ({ home: base }), subscribe: () => () => {} } }),
      locale: { register: (ns, dict) => { dictionaries.set(ns, dict); return () => {} },
        bind: ns => (key, args) => { let value = dictionaries.get(ns)?.[window.lang ?? 'zh']?.[key] ?? key; for (const [k, v] of Object.entries(args ?? {})) value = value.replaceAll(`{${k}}`, v); return value } },
      workspaces, sessions: { searchResultLimit: 20 },
      slots: { inject: (_name, fn) => fn(), register: (def, component) => { slotMap.set(def.name, { def, component }); return () => slotMap.delete(def.name) },
        entries: name => slotMap.has(name) ? [slotMap.get(name)] : [], subscribe: () => () => {} },
    }
    registrations['@deepseek-ai/dsh-client-ui-theme'].factory(readModule).apply(ctx)
    document.documentElement.dataset.theme = 'light'
    for (const [name, value] of Object.entries(ctx.theme.getTheme().active.tokens)) document.documentElement.style.setProperty(name, value)
    registrations['@deepseek-ai/dsh-client-ui-workspace'].factory(readModule).apply(ctx)
    registrations['@xlang/xharness-client-ui-directory'].factory(readModule).apply(ctx)
    const renderSlot = (name, owner) => { const { def, component } = slotMap.get(name); return h(component, { ...def.inject(), ...owner }) }
    const sessions = { items: [], ids: [], byId: {}, current: undefined, phase: 'ready' }
    const store = slotMap.get('sidebar.workspaces').def.store.init()
    const noOp = () => {}
    const actions = new Proxy({}, { get: () => noOp })
    let reactRoot = staticModules['react-dom/client'].createRoot(document.getElementById('root'))
    window.mount = surface => {
      reactRoot.unmount()
      reactRoot = staticModules['react-dom/client'].createRoot(document.getElementById('root'))
      const name = surface === 'sidebar' ? 'sidebar.workspaces' : 'conversation.hero.workspace'
      const { def, component } = slotMap.get(name)
      const injected = def.inject()
      function Owner() {
        const [open, setOpen] = React.useState(false)
        const anchorRef = React.useRef(null)
        return h(React.Fragment, null,
          surface !== 'sidebar' && h('button', { ref: anchorRef, onClick: () => setOpen(true) }, '选择工作区'),
          h(component, { ...injected, t: ctx.locale.bind('workspace'), renderSlot,
            open: surface === 'sidebar' ? noOp : open, anchorRef, wide: true, expandSidebar: noOp,
            useWorkspaces: select => select(workspaceSnapshot), useSessions: select => select(sessions),
            useStore: select => select(store), actions, useHostDescription: select => select({ home: base }),
            useDirectoryFlow: select => select(injected.hooks.directoryFlow.getSnapshot()),
            onPick: id => calls.picks.push(id), onClose: () => setOpen(false) }))
      }
      ReactDOM.flushSync(() => reactRoot.render(h(Owner)))
    }
    mount('sidebar')
  })
  const dialog = () => page.getByRole('dialog', { name: '选择工作区目录' })
  const path = () => dialog().getByRole('textbox', { name: '目录路径', exact: true })
  const open = () => dialog().getByRole('button', { name: '打开工作区', exact: true })
  const add = () => page.getByRole('button', { name: '添加工作区', exact: true })
  const shortcuts = () => dialog().getByRole('navigation', { name: '磁盘和位置', exact: true })
  const shortcut = label => shortcuts().getByRole('button', { name: label, exact: true })
  const ready = async () => { await dialog().waitFor(); await page.waitForFunction(() => !document.querySelector('.xhdir-content')?.getAttribute('aria-busy')?.includes('true')) }
  const go = async value => { await path().fill(value); await dialog().getByRole('button', { name: '前往', exact: true }).click() }
  await add().click(); await ready()
  assert.equal(await path().inputValue(), '', 'first use starts at the location overview')
  assert.equal(await open().isDisabled(), true, 'virtual overview must not be adopted')
  assert.equal(await dialog().getByRole('button', { name: '+ 新建文件夹', exact: true }).isDisabled(), true)
  await shortcut('Z:\\').click(); await ready()
  await dialog().getByRole('alert').waitFor()
  assert.equal(await open().isDisabled(), true)
  await shortcut('C:\\').click(); await ready()
  assert.equal(await path().inputValue(), 'C:\\')
  await shortcut('D:\\').click(); await ready()
  assert.equal(await path().inputValue(), 'D:\\')
  await dialog().getByRole('button', { name: '工作区', exact: true }).click(); await ready()
  assert.equal(await path().inputValue(), 'D:\\工作区')
  await open().focus(); await page.keyboard.press('Tab')
  assert.equal(await shortcut('磁盘和位置').evaluate(element => element === document.activeElement), true, 'focus must wrap to the first picker control')
  assert.equal(await page.evaluate(() => document.getElementById('root').inert), true)
  assert.equal(await dialog().getByRole('button', { name: '.hidden', exact: true }).count(), 0)
  await dialog().getByRole('checkbox').check()
  await dialog().getByRole('button', { name: '.hidden', exact: true }).waitFor()
  await dialog().getByRole('button', { name: '已有项目', exact: true }).click(); await ready(); await open().click()
  await dialog().waitFor({ state: 'detached' })
  assert.equal(await page.evaluate(() => document.getElementById('root').inert), false)
  assert.deepEqual(await page.evaluate(() => calls.adopts), [{ path: 'D:\\工作区\\已有项目' }])
  assert.deepEqual(await page.evaluate(() => calls.picks), ['D:\\工作区\\已有项目'])
  await page.evaluate(() => mount('hero'))
  await page.getByRole('button', { name: '选择工作区', exact: true }).click(); await ready()
  assert.equal(await path().inputValue(), 'D:\\工作区\\已有项目', 'both entry points share the last successful location')
  assert.equal(await page.evaluate(() => sessionStorage.getItem('xharness.directory.lastPath.v1')), 'D:\\工作区\\已有项目')
  await shortcut('主目录').click(); await ready()
  await dialog().getByRole('button', { name: '+ 新建文件夹', exact: true }).click()
  const name = dialog().getByRole('textbox', { name: '文件夹名称', exact: true })
  await name.fill('已有项目'); await dialog().getByRole('button', { name: '创建', exact: true }).click()
  await dialog().getByRole('alert').filter({ hasText: 'Folder exists' }).waitFor()
  await name.fill('中文新项目')
  await page.evaluate(() => { blockCreate = true })
  await dialog().getByRole('button', { name: '创建', exact: true }).click()
  assert.equal(await dialog().getByRole('button', { name: '创建', exact: true }).isDisabled(), true)
  await page.keyboard.press('Escape'); assert.equal(await name.count(), 1)
  await page.evaluate(() => { blockCreate = false; pending.create() })
  await ready(); await name.waitFor({ state: 'detached' })
  assert.equal(await path().inputValue(), 'D:\\工作区\\中文新项目')
  assert.equal(await page.evaluate(() => calls.creates.length), 2)
  await open().click(); await dialog().waitFor({ state: 'detached' })
  assert.equal(await page.evaluate(() => calls.picks.at(-1)), 'D:\\工作区\\中文新项目')

  await page.getByRole('button', { name: '选择工作区', exact: true }).click(); await ready()
  await go('missing'); await dialog().getByRole('alert').waitFor(); assert.equal(await open().isDisabled(), true)
  await page.evaluate(() => paths.set('missing', [])); await dialog().getByRole('button', { name: '重试', exact: true }).click(); await ready()
  assert.equal(await path().inputValue(), 'missing')
  for (const target of ['C:\\', '\\\\server\\share', '/tmp/projects']) { await go(target); await ready(); assert.equal(await path().inputValue(), target) }
  await path().fill('unsubmitted'); assert.equal(await open().isDisabled(), true)
  await page.evaluate(() => { blockRead = 'slow' }); await go('slow')
  await path().fill('new draft'); await page.evaluate(() => pending.read())
  assert.equal(await path().inputValue(), 'new draft', 'late scan must not overwrite a typed draft')
  assert.equal(await open().isDisabled(), true)
  await go('slow')
  await go('D:\\工作区'); await ready()
  await page.evaluate(() => pending.read()); assert.equal(await path().inputValue(), 'D:\\工作区')
  await go('slow'); await dialog().getByRole('button', { name: '取消', exact: true }).click()
  await dialog().waitFor({ state: 'detached' }); await page.evaluate(() => pending.read())
  assert.equal(await page.evaluate(() => calls.adopts.length), 2, 'cancel never registers a workspace')
  assert.ok(await page.evaluate(() => calls.aborts > 0))
  await page.getByRole('button', { name: '选择工作区', exact: true }).click(); await ready()
  assert.equal(await path().inputValue(), 'D:\\工作区', 'late cancelled scan must not affect reopened picker')
  const beforeIME = await page.evaluate(() => calls.lists.length)
  await path().dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true })
  assert.equal(await page.evaluate(() => calls.lists.length), beforeIME)
  await page.evaluate(() => { failAdopt = true }); await open().click()
  await page.getByRole('alert').filter({ hasText: 'Workspace registration failed' }).waitFor()
  await page.evaluate(() => { failAdopt = false; mount('sidebar') })
  // Stale saved paths fall back without ever adopting an empty/old directory.
  await page.evaluate(() => sessionStorage.setItem('xharness.directory.lastPath.v1', 'removed-drive'))
  await add().click(); await ready()
  assert.equal(await path().inputValue(), '')
  await dialog().getByRole('status').filter({ hasText: '上次浏览的位置暂不可用' }).waitFor()
  assert.equal(await open().isDisabled(), true)
  await dialog().getByRole('button', { name: '取消', exact: true }).click()
  // Older hosts reject empty paths. The picker still opens Home and typed paths.
  await page.evaluate(() => { oldHost = true })
  await add().click(); await ready()
  assert.equal(await path().inputValue(), 'D:\\工作区')
  await dialog().getByRole('status').filter({ hasText: '磁盘列表暂不可用' }).waitFor()
  await go('C:\\'); await ready()
  assert.equal(await path().inputValue(), 'C:\\')
  await dialog().getByRole('button', { name: '取消', exact: true }).click()
  await page.evaluate(() => {
    oldHost = false
    window.savedStorage = { get: Storage.prototype.getItem, set: Storage.prototype.setItem }
    Storage.prototype.setItem = () => { throw new DOMException('Storage full', 'QuotaExceededError') }
  })
  await add().click(); await ready()
  assert.equal(await path().inputValue(), 'C:\\', 'blocked storage falls back to in-memory location')
  await shortcut('D:\\').click(); await ready()
  await dialog().getByRole('button', { name: '取消', exact: true }).click()
  await add().click(); await ready()
  assert.equal(await path().inputValue(), 'D:\\', 'a failed storage write must not resurrect the older saved path')
  await dialog().getByRole('button', { name: '取消', exact: true }).click()
  await page.evaluate(() => { Storage.prototype.getItem = () => { throw new DOMException('Storage blocked', 'SecurityError') } })
  await add().click(); await ready()
  assert.equal(await path().inputValue(), 'D:\\', 'memory-only navigation survives picker remount')
  await page.evaluate(() => { Storage.prototype.getItem = savedStorage.get; Storage.prototype.setItem = savedStorage.set })
  await shortcut('主目录').click(); await ready()
  for (const size of [{ width: 960, height: 720 }, { width: 360, height: 520 }]) {
    await page.setViewportSize(size)
    const box = await open().boundingBox()
    assert.ok(box.x >= 0 && box.x + box.width <= size.width && box.y >= 0 && box.y + box.height <= size.height, JSON.stringify(box))
    await dialog().getByRole('button', { name: '+ 新建文件夹', exact: true }).click()
    const createBox = await dialog().getByRole('button', { name: '创建', exact: true }).boundingBox()
    assert.ok(createBox.y >= 0 && createBox.y + createBox.height <= size.height, JSON.stringify(createBox))
    await page.keyboard.press('Escape'); await name.waitFor({ state: 'detached' })
  }
  const evidence = resolve(process.env.UI_TEST_EVIDENCE ?? resolve(root, 'dist/workspace-directory-evidence'))
  mkdirSync(evidence, { recursive: true })
  await page.screenshot({ path: resolve(evidence, `${engine}-narrow.png`) })
  await page.setViewportSize({ width: 960, height: 720 })
  await dialog().getByRole('button', { name: '+ 新建文件夹', exact: true }).click()
  await name.fill('新的工作区')
  await page.screenshot({ path: resolve(evidence, `${engine}-create.png`) })
  await page.keyboard.press('Escape'); await name.waitFor({ state: 'detached' })
  await shortcut('磁盘和位置').click(); await ready()
  await page.screenshot({ path: resolve(evidence, `${engine}-locations.png`) })
  // Refresh assigned drives without restarting the picker.
  await page.evaluate(() => { drives = ['C:\\', 'D:\\', 'E:\\']; paths.set('E:\\', []) })
  await shortcut('磁盘和位置').click(); await ready()
  assert.equal(await shortcut('Z:\\').count(), 0)
  await shortcut('E:\\').click(); await ready()
  assert.equal(await path().inputValue(), 'E:\\')
  assert.deepEqual(errors, [])
  console.log(`${engine}: shipped sidebar/hero, drives/refresh, virtual-root safety, remembered paths/fallback, blocked storage, old host, existing/new workspace, errors/retry, paths, late reads/cancel, duplicate create guard, IME and layout passed`)
} finally { await browser.close() }
