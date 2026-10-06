import {installOwnedViewHtml} from './fixtures/owned-view-platform-browser.mjs'
import {ownedViewModuleTestInput} from './owned-view-module-test-input.mjs'
// Mock only the Tauri boundary; exercise the shipped React browser pane.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const deps = resolve(process.env.UI_TEST_DEPS ?? '/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps')
const require = createRequire(resolve(deps, 'package.json'))
const { chromium, webkit } = require('playwright')
const engine = process.env.UI_TEST_BROWSER ?? 'chromium'
const browser = await ({ chromium, webkit })[engine].launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 700 } })
  const errors = []
  page.on('pageerror', error => {if(error.message!=='owned feature fixture: stop Host boot')errors.push(error.message)})
  await installOwnedViewHtml(page,process.env.UI_TEST_IMPL??'canonical',`<html><body style="margin:0"><div id="root" style="width:600px;height:500px"></div>
    <div data-shell-overlay="true"></div>
    <div data-composer-seat style="display:none"><textarea placeholder="Message the agent"></textarea></div>
    <div data-composer-card><textarea id="composer" placeholder="给智能体发消息"></textarea></div>
    <button data-xh-terminal-trigger data-xh-terminal-open="false" title="终端">终端</button>
  </body></html>`)
  await page.addScriptTag({ content: `
    window.commands=[];window.listeners=[];window.closeRequests=0;window.terminalClicks=0;
    window.activeTab=null;window.nativeTabs=new Set();window.hold=null;window.failBounds=false;
    document.querySelector('[data-xh-terminal-trigger]').onclick=()=>{
      terminalClicks++;document.querySelector('[data-xh-terminal-trigger]').dataset.xhTerminalOpen='true';
    };
    window.__TAURI__={core:{invoke:async(command,args)=>{
      commands.push({command,args});
      if(hold?.command===command){const gate=hold;hold=null;window.gateStarted=true;
        await new Promise((resolve,reject)=>{window.releaseGate=()=>gate.fail?reject(Error('native failed')):resolve()});}
      if(command==='desktop_browser_bounds'&&window.failBounds)throw Error('native failed');
      if(command==='desktop_browser_activate'){activeTab=args.tabId;return nativeTabs.has(args.tabId)}
      if(command==='desktop_browser_navigate'){nativeTabs.add(args.tabId);activeTab=args.tabId}
      if(command==='desktop_browser_close'){nativeTabs.delete(args.tabId);if(activeTab===args.tabId)activeTab=null}
    }},event:{listen:async(_name,fn)=>{listeners.push(fn);return()=>{listeners=listeners.filter(x=>x!==fn)}}}};
    window.__ModuleLoader__={load:x=>window.registration=x};
  ` })
  await page.addScriptTag({ content: ownedViewModuleTestInput('@xlang/xharness-client-ui-browser') })
  await page.evaluate(() => {
    const plugin = registration.factory(id => id === 'react' ? React : {})
    const components = {}
    plugin.apply({
      effect: fn => fn(),
      slots: { inject: (_name, fn) => fn(), register: (config, component) => { components[config.id] = component } },
    })
    window.root = ReactDOM.createRoot(document.getElementById('root'))
    function App() {
      const [item, setItem] = React.useState({ id: 'browser:1', kind: 'browser', entries: [], position: -1, title: '新标签页' })
      const [open, setOpen] = React.useState(true)
      window.setBrowserOpen = setOpen; window.setBrowserItem = setItem
      return React.createElement(components['browser-pane'], { item, open, onUpdate: patch => setItem(value => ({ ...value, ...patch })), onClose: () => { window.closeRequests++ }, onNewBrowser: () => {} })
    }
    root.render(React.createElement(App))
  })
  // Localization, steer placeholders, hidden inputs and already-open terminals.
  for (const placeholder of ['给智能体发消息', 'Cmd/Ctrl+Enter 插话发送全部排队消息', 'Message the agent', 'Cmd/Ctrl+Enter steers all queued messages']) {
    await page.evaluate(value => { document.getElementById('composer').placeholder = value }, placeholder)
    await page.getByRole('button', { name: '回到聊天', exact: true }).first().click()
    await page.waitForFunction(() => document.activeElement?.id === 'composer')
    assert.equal(await page.evaluate(() => window.closeRequests), 0)
  }
  for (const title of ['终端', 'Terminal']) {
    await page.evaluate(value => { const trigger = document.querySelector('[data-xh-terminal-trigger]'); trigger.title = value; trigger.dataset.xhTerminalOpen = 'false' }, title)
    const before = await page.evaluate(() => window.terminalClicks)
    await page.getByRole('button', { name: '打开终端', exact: true }).click()
    await page.getByRole('button', { name: '打开终端', exact: true }).click()
    assert.equal(await page.evaluate(() => window.terminalClicks), before + 1, 'open terminal must not toggle an existing dock closed')
  }
  await page.evaluate(() => { document.getElementById('composer').disabled = true; document.getElementById('root').dataset.xhworkspaceDrawer = '' })
  await page.getByRole('button', { name: '回到聊天', exact: true }).first().click()
  await page.getByRole('alert').getByText('当前页面没有可用的聊天输入框').waitFor()
  assert.equal(await page.evaluate(() => window.closeRequests), 0, 'missing composer must not close the browser')
  await page.evaluate(() => { document.getElementById('composer').disabled = false })
  await page.getByRole('button', { name: '回到聊天', exact: true }).first().click()
  await page.waitForFunction(() => document.activeElement?.id === 'composer')
  assert.equal(await page.evaluate(() => window.closeRequests), 1, 'drawer closes only when chat can receive focus')
  await page.evaluate(() => { delete document.getElementById('root').dataset.xhworkspaceDrawer; document.querySelector('[data-xh-terminal-trigger]').disabled = true })
  await page.getByRole('button', { name: '打开终端', exact: true }).click()
  await page.getByRole('alert').getByText('当前页面没有可用的终端').waitFor()
  assert.equal(await page.evaluate(() => commands.some(call => call.args?.tabId === 'browser:1')), false, 'blank home must not activate a native page')

  if (process.env.UI_TEST_IMPL !== 'legacy') assert.equal(await page.locator('.xhbrowser-footer, .xhbrowser-status-dot').count(), 0, 'native pane has no engine status strip or empty footer')
  const address = page.getByRole('textbox', { name: '网址' })
  await address.fill('example.com'); await address.press('Enter')
  await page.waitForFunction(() => commands.some(call => call.command === 'desktop_browser_navigate'))
  const calls = await page.evaluate(() => window.commands)
  const bounds = calls.find(call => call.command === 'desktop_browser_bounds')
  assert.ok(bounds.args.bounds.width > 100 && bounds.args.bounds.height > 100)
  assert.equal(calls.find(call => call.command === 'desktop_browser_navigate').args.url, 'https://example.com/')
  assert.equal(await page.getByText('网页版不能嵌入 example.com').count(), 0)
  await page.evaluate(() => listeners.forEach(fn => fn({ payload: { tabId: 'browser:1', kind: 'download-complete', value: '/tmp/example.zip' } })))
  await page.getByRole('button', { name: '下载记录' }).click()
  await page.getByRole('region', { name: '下载记录' }).getByText('example.zip', { exact: true }).waitFor()
  await page.getByRole('region', { name: '下载记录' }).getByText('已完成', { exact: true }).waitFor()
  await page.getByRole('button', { name: '下载记录' }).click()
  // A queued reload acts as a barrier after React/layout observers and native work.
  const flush = async () => {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const count = await page.evaluate(() => commands.filter(call => call.command === 'desktop_browser_action' && call.args.action === 'reload').length)
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await page.waitForFunction(count => commands.filter(call => call.command === 'desktop_browser_action' && call.args.action === 'reload').length > count, count)
  }
  const resize = async () => page.evaluate(() => {
    const root = document.getElementById('root'); root.style.height = `${parseInt(root.style.height) + 3}px`; window.dispatchEvent(new Event('resize'))
  })
  const assertHidden = async () => { await flush(); assert.equal(await page.evaluate(() => window.activeTab), null) }
  const assertNoShow = async start => {
    await assertHidden()
    const calls = await page.evaluate(start => commands.slice(start), start)
    assert.equal(calls.some(call => call.command === 'desktop_browser_navigate' || (call.command === 'desktop_browser_activate' && call.args.tabId !== null)), false,
      'resize while blocked must not activate or navigate a child WebView')
  }
  await flush()
  await page.evaluate(() => listeners.forEach(fn => fn({ payload: { tabId: 'browser:1', kind: 'url', value: 'https://example.com/next' } })))
  await page.waitForFunction(() => document.querySelector('input[aria-label="网址"]')?.value === 'https://example.com/next')
  await page.evaluate(() => listeners.forEach(fn => fn({ payload: { tabId: 'browser:1', kind: 'download-complete', value: '/Users/test/Downloads/example.pdf' } })))
  for (const label of ['下载记录', '更多浏览器操作']) {
    await page.getByRole('button', { name: label, exact: true }).click()
    await assertHidden()
    if (label === '下载记录') {
      await page.getByRole('region', { name: '下载记录' }).getByText('example.pdf').waitFor()
      assert.equal(await page.getByRole('region', { name: '下载记录' }).getByText('/Users/test/Downloads/').count(), 0)
    }
    const start = await page.evaluate(() => commands.length)
    await resize(); await page.setViewportSize({ width: 970, height: 710 }); await assertNoShow(start)
    await page.getByRole('button', { name: label, exact: true }).click()
    await flush(); assert.equal(await page.evaluate(() => window.activeTab), 'browser:1')
  }
  const beforeEscape = await page.evaluate(() => window.closeRequests)
  await page.getByRole('button', { name: '下载记录', exact: true }).click()
  await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('button', { name: '下载记录', exact: true }).getAttribute('aria-expanded'), 'false')
  assert.equal(await page.evaluate(() => window.closeRequests), beforeEscape, 'Escape dismisses the local popup before closing the workspace')
  await flush()
  // Each native await is a cancellation/visibility boundary, not just queue entry.
  for (const command of ['desktop_browser_bounds', 'desktop_browser_activate', 'desktop_browser_navigate']) {
    await page.evaluate(command => { window.hold = { command }; window.gateStarted = false }, command)
    if (command === 'desktop_browser_navigate') { await address.fill('example.org'); await address.press('Enter') }
    else await resize()
    await page.waitForFunction(() => window.gateStarted)
    await page.getByRole('button', { name: '下载记录', exact: true }).click()
    const start = await page.evaluate(() => commands.length)
    await page.evaluate(() => window.releaseGate())
    await assertNoShow(start)
    await resize(); await assertNoShow(start)
    await page.getByRole('button', { name: '下载记录', exact: true }).click()
    await flush(); assert.equal(await page.evaluate(() => window.activeTab), 'browser:1')
  }
  // Navigation requested while blocked is retained, but executed only once visible.
  await page.getByRole('button', { name: '下载记录', exact: true }).click()
  await assertHidden()
  const blockedStart = await page.evaluate(() => commands.length)
  await address.fill('example.net'); await address.press('Enter')
  await assertNoShow(blockedStart)
  await page.getByRole('button', { name: '下载记录', exact: true }).click()
  await flush()
  assert.equal(await page.evaluate(start => commands.slice(start).filter(call => call.command === 'desktop_browser_navigate' && call.args.url === 'https://example.net/').length, blockedStart), 1)
  // Global modal composition: dismissing a pane popover must not expose a modal.
  await page.evaluate(() => {
    const dialog = document.createElement('div'); dialog.role = 'alertdialog'; dialog.textContent = 'A modal'; document.querySelector('[data-shell-overlay]').append(dialog)
  })
  await assertHidden()
  await page.getByRole('button', { name: '下载记录', exact: true }).click()
  await page.getByRole('button', { name: '下载记录', exact: true }).click()
  await resize(); await assertHidden()
  await page.evaluate(() => document.querySelector('[role="alertdialog"]').setAttribute('aria-hidden', 'true'))
  await flush(); assert.equal(await page.evaluate(() => window.activeTab), 'browser:1')
  await page.evaluate(() => document.querySelector('[role="alertdialog"]').remove())
  // A portaled menu is not a modal and is outside the shell slot. Native
  // views must yield without waiting for a resize or a browser toolbar click.
  await page.evaluate(() => {
    const menu = document.createElement('div'); menu.id = 'portal-menu'; menu.role = 'menu'
    menu.textContent = 'Model selection'
    menu.style.cssText = 'position:fixed;left:450px;top:200px;width:200px;height:100px;z-index:100;background:white'
    document.body.append(menu)
  })
  await assertHidden()
  const closeCount = await page.evaluate(() => window.closeRequests)
  await page.evaluate(() => document.getElementById('portal-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  assert.equal(await page.evaluate(() => window.closeRequests), closeCount, 'an overlay owns Escape, not the browser underneath')
  await resize(); await assertHidden()
  await page.evaluate(() => document.getElementById('portal-menu').remove())
  await flush(); assert.equal(await page.evaluate(() => window.activeTab), 'browser:1')
  const addSurface = async ({ role = '', parent = 'body', style = '', child = false } = {}) => page.evaluate(({ role, parent, style, child }) => {
    const wrapper = document.createElement('div'); wrapper.id = 'layer-fixture'
    const card = child ? document.createElement('div') : wrapper
    if (role) card.setAttribute('role', role)
    card.textContent = 'Global UI'
    card.style.cssText = 'position:fixed;left:450px;top:200px;width:200px;height:100px;z-index:100;background:white;' + style
    if (child) wrapper.append(card)
    document.querySelector(parent).append(wrapper)
  }, { role, parent, style, child })
  const removeSurface = async () => {
    await page.evaluate(() => document.getElementById('layer-fixture').remove())
    await flush(); assert.equal(await page.evaluate(() => window.activeTab), 'browser:1')
  }
  // Current settings are body-portaled, not children of data-shell-overlay.
  await addSurface({ role: 'dialog', child: true, style: 'left:700px' })
  await assertHidden() // Modals own the entire app, even outside the page rect.
  await removeSurface()
  for (const surface of [
    { role: 'listbox', child: true },
    { role: 'tooltip', style: 'pointer-events:none' },
    { parent: '[data-shell-overlay]' }, // Slash/popupSelect card, no modal role.
    {}, // Schedule/download portal, no ARIA role.
  ]) {
    await addSurface(surface); await assertHidden()
    await resize(); await assertHidden()
    await removeSurface()
  }
  // A chat-local menu does not blank a non-overlapping browser. Moving it or
  // changing ancestor visibility is observed even without resizing the window.
  await addSurface({ role: 'menu', child: true, style: 'left:700px' })
  await flush(); assert.equal(await page.evaluate(() => window.activeTab), 'browser:1')
  await page.evaluate(() => document.querySelector('#layer-fixture > div').style.left = '450px')
  await assertHidden()
  for (const [attribute, value] of [['aria-hidden', 'true'], ['hidden', ''], ['style', 'display:none']]) {
    await page.evaluate(([attribute, value]) => document.getElementById('layer-fixture').setAttribute(attribute, value), [attribute, value])
    await flush(); assert.equal(await page.evaluate(() => window.activeTab), 'browser:1')
    await page.evaluate(attribute => document.getElementById('layer-fixture').removeAttribute(attribute), attribute)
    await assertHidden()
  }
  // A fixed app root is not a floating menu ancestor. Ordinary list content
  // must not blank the native page just because its DOM rectangle overlaps it.
  await removeSurface()
  await page.evaluate(() => {
    const root = document.getElementById('root'); root.style.position = 'fixed'
    const list = document.createElement('div'); list.id = 'inline-list'; list.role = 'listbox'; list.textContent = 'Chat list'
    list.style.cssText = 'width:200px;height:100px;margin-top:-300px'; root.append(list)
  })
  await flush(); assert.equal(await page.evaluate(() => window.activeTab), 'browser:1')
  await page.evaluate(() => { document.getElementById('inline-list').remove(); document.getElementById('root').style.position = '' })
  await addSurface({ role: 'menu', child: true }); await assertHidden()
  // Multiple overlay owners compose. Closing one cannot expose the other.
  await page.evaluate(() => {
    const second = document.getElementById('layer-fixture').cloneNode(true); second.id = 'second-layer'; document.body.append(second)
    document.getElementById('layer-fixture').remove()
  })
  await assertHidden()
  await page.evaluate(() => document.getElementById('second-layer').remove())
  await flush(); assert.equal(await page.evaluate(() => window.activeTab), 'browser:1')
  // Mutation during an in-flight activation must win before native work resumes.
  for (const command of ['desktop_browser_bounds', 'desktop_browser_activate', 'desktop_browser_navigate']) {
    await page.evaluate(command => { window.hold = { command }; window.gateStarted = false }, command)
    if (command === 'desktop_browser_navigate') { await address.fill('example.io'); await address.press('Enter') }
    else await resize()
    await page.waitForFunction(() => window.gateStarted)
    await addSurface({ role: 'menu', child: true })
    const start = await page.evaluate(() => commands.length)
    await page.evaluate(() => window.releaseGate())
    await assertNoShow(start)
    await removeSurface()
  }
  // Streamed chat content is not an overlay and causes no native hide/show IPC.
  await flush()
  const streamStart = await page.evaluate(() => commands.length)
  await page.evaluate(() => {
    const messages = document.createElement('div'); document.getElementById('root').append(messages)
    for (let i = 0; i < 100; i++) messages.append(document.createTextNode(' delta'))
    messages.remove()
  })
  await flush()
  assert.equal(await page.evaluate(start => commands.slice(start).some(call =>
    ['desktop_browser_bounds', 'desktop_browser_activate', 'desktop_browser_navigate'].includes(call.command)), streamStart), false,
  'ordinary chat changes must not churn the native view')
  // A rejected native call must not poison subsequent synchronization.
  // A resize event and ResizeObserver can supersede the first held request.
  // Its stale error is correctly ignored. Keep the native fault active until
  // a current synchronization reports it, then verify recovery without
  // relaxing the visible-error or subsequent-activation assertions.
  await page.evaluate(() => { window.failBounds = true })
  await resize()
  await page.getByRole('alert').getByText('native failed', { exact: false }).waitFor()
  await page.evaluate(() => { window.failBounds = false })
  await resize(); await flush(); assert.equal(await page.evaluate(() => window.activeTab), 'browser:1')
  // Pending old-tab work cannot show again after close/reopen or a blank new tab.
  await page.evaluate(() => { window.hold = { command: 'desktop_browser_bounds' }; window.gateStarted = false })
  await resize(); await page.waitForFunction(() => window.gateStarted)
  await page.evaluate(() => window.setBrowserOpen(false))
  await page.waitForFunction(() => window.listeners.length === 1)
  const start = await page.evaluate(() => commands.length)
  await page.evaluate(() => window.releaseGate()); await assertNoShow(start)
  await page.evaluate(() => window.setBrowserOpen(true)); await flush()
  assert.equal(await page.evaluate(() => window.activeTab), 'browser:1')
  await page.evaluate(() => { window.hold = { command: 'desktop_browser_activate' }; window.gateStarted = false })
  await resize(); await page.waitForFunction(() => window.gateStarted)
  await page.evaluate(() => window.setBrowserItem({ id: 'browser:2', kind: 'browser', entries: ['https://example.edu/'], position: 0, title: 'example.edu' }))
  await page.waitForFunction(() => document.querySelector('input[aria-label="网址"]')?.value === 'https://example.edu/')
  const switchedStart = await page.evaluate(() => commands.length)
  await page.evaluate(() => window.releaseGate())
  await flush()
  assert.equal(await page.evaluate(() => window.activeTab), 'browser:2')
  assert.equal(await page.evaluate(start => commands.slice(start).some(call => call.args?.tabId === 'browser:1'), switchedStart), false, 'old-tab work cannot reactivate or navigate after a switch')
  await page.evaluate(() => window.setBrowserItem({ id: 'browser:2', kind: 'browser', entries: [], position: -1, title: '新标签页' }))
  await page.getByRole('button', { name: '打开终端', exact: true }).waitFor()
  await page.waitForFunction(() => window.activeTab === null)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('xharness:browser-close', { detail: { id: 'browser:2' } })))
  await page.waitForFunction(() => commands.some(call => call.command === 'desktop_browser_close'))
  await page.evaluate(() => root.unmount())
  assert.deepEqual(errors, [])
  console.log(`${engine}: native browser visibility, async races and localized shortcuts passed`)
} finally { await browser.close() }
