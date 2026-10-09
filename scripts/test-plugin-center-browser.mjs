import {openAccountSettings} from './fixtures/open-account-settings.mjs'
import {installShellSessionsFixture} from './fixtures/shell-navigation-browser.mjs'
// Browser-level navigation regression using the shipped AppFrame implementation.
// The Host and its private data are fixtures; no user's running session is touched.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const assetDist = resolve(process.env.UI_TEST_DIST ?? fileURLToPath(new URL('ui/dist/', root)))
const source = readFileSync(resolve(assetDist, 'plugins/@xharness/dsh-client-ui-layout/client.js'), 'utf8')
const deps = resolve(process.env.UI_TEST_DEPS ?? '/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps')
const require = createRequire(resolve(deps, 'package.json'))
const browserName = process.env.UI_TEST_BROWSER ?? 'chromium'
assert.ok(['chromium', 'webkit'].includes(browserName))
const browser = await require('playwright')[browserName].launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 }, locale: 'en-US' })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setContent('<div id="root"></div>')
  for (const file of ['react/umd/react.development.js', 'react-dom/umd/react-dom.development.js']) {
    await page.addScriptTag({ path: resolve(deps, 'node_modules', file) })
  }
  await installShellSessionsFixture(page)
  await page.addScriptTag({ content: `
    const react=React;
    const react_jsx_runtime={jsx:(type,props,key)=>React.createElement(type,{...props,key}),jsxs:(type,props,key)=>React.createElement(type,{...props,key}),Fragment:React.Fragment};
    const seed = name => {
      if(name==='react')return React;
      if(name==='react/jsx-runtime')return react_jsx_runtime;
      if(name==='@xharness/dsh-client-runtime/client')return {defineStore:spec=>({spec})};
      throw new Error('Unexpected layout dependency: '+name);
    };
    window.__ModuleLoader__={load:registration=>{window.layoutModule=registration.factory(seed)}};
    ${source}
    const shellSessions=createShellSessionsFixture({phase:'pending'});window.shellSessions=shellSessions;
    let AppFrame,rootDefinition;
    window.layoutModule.apply({get:name=>name==='sessions'?shellSessions:undefined,
      effect:fn=>fn(), reflect:{provide:()=>()=>{}},
      slots:{register:(spec,component)=>{if(spec.name==='root'){AppFrame=component;rootDefinition=spec};return()=>{}}},
      theme:{getTheme:()=>({active:{colorScheme:'dark',tokens:{}}})}, on:()=>()=>{},
    });
    if(!AppFrame)throw new Error('Shipped layout did not register its root component');
    const sessions={current:undefined,byId:{}};
    const panels={sidebar:0,details:0,narrow:false,narrowExpanded:false};
    const actions={closeDetails(){},setNarrow(){},setSidebar(){},setDetails(){}};
    const renderSlot=name=>{
      if(name==='sidebar')return React.createElement('nav',null,
        React.createElement('button',{'data-xharness-plugin-nav':true,onClick:()=>window.dispatchEvent(new Event('xharness:plugins:open'))},'Plugins'),
        React.createElement('button',null,'Search'));
      if(name==='conversation')return React.createElement('p',null,'Chat content');
      if(name==='plugins.center')return React.createElement('p',null,'Plugin inventory');
      return null;
    };
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(AppFrame,{useStore:f=>f(panels),useSessions:f=>f(React.useSyncExternalStore(shellSessions.list.subscribe,shellSessions.list.getSnapshot)),actions,...rootDefinition.inject(actions),renderSlot}));
  ` })
  await page.getByText('Chat content').waitFor()
  await page.getByRole('button', { name: 'Plugins' }).click()
  await page.getByText('Plugin inventory').waitFor()
  // Simulate late Host connection without resetting the current page.
  await page.evaluate(()=>shellSessions.update({phase:'ready',current:'restored',ids:['restored'],byId:{restored:{blank:false}}}))
  assert.equal(await page.getByText('Plugin inventory').isVisible(),true,'first successful session list preserves the offline page')
  assert.equal(await page.getByText('Chat content').count(), 1, 'retain the conversation subtree while navigating so drafts and scroll state survive')
  assert.equal(await page.getByText('Chat content').isVisible(), false, 'retained chat is hidden, not overlaid on the plugin page')
  await page.getByRole('button', { name: 'Search' }).click()
  await page.getByText('Chat content').waitFor()
  await page.getByRole('button', { name: 'Plugins' }).click()
  await page.getByText('Plugin inventory').waitFor()
  await page.getByRole('button', { name: 'Back to chat' }).click()
  await page.getByText('Chat content').waitFor()
  assert.deepEqual(errors, [])

  // English selectors require a deterministic locale, independent of the runner.
  // Load the actual shipped bundles at both sidebar widths. This catches
  // duplicate responsive controls that AppFrame-only fixtures cannot see.
  const dist = assetDist
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
    const file = resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`)
    if (!file.startsWith(dist + sep)) {
      response.writeHead(403).end()
      return
    }
    try {
      const body = readFileSync(file)
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' }[extname(file)] ?? 'application/octet-stream'
      const send = () => response.writeHead(200, { 'Content-Type': mime }).end(body)
      // Force the typed dependency to arrive after the other scripts. Correct
      // external edges must prevent the hub factory from requiring it early.
      // A graph-order-only or inject-only integration fails this cold boot.
      if (pathname === '/plugins/@xlang/xharness-client-plugin-api/client.js') setTimeout(send, 300)
      else send()
    } catch {
      response.writeHead(404).end()
    }
  })
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  try {
    const url = `http://127.0.0.1:${server.address().port}/`
    for (const width of [800, 1200]) {
      const shipped = await browser.newPage({ viewport: { width, height: 700 }, locale: 'en-US' })
      const shippedErrors = []
      shipped.on('pageerror', error => shippedErrors.push(error.message))
      await shipped.goto(url, { waitUntil: 'domcontentloaded' })
      const plugins = shipped.getByRole('button', { name: 'Plugins', exact: true })
      try { await plugins.waitFor() }
      catch (error) {
        // Retain the startup failure, rather than silently retrying a flaky
        // assertion. CI logs must say whether the loader or navigation failed.
        console.error('Plugin navigation startup evidence:', JSON.stringify({ width, browserName,
          pageErrors: shippedErrors, body: (await shipped.locator('body').innerText()).slice(0, 2000) }))
        throw error
      }
      assert.equal(await plugins.count(), 1, `exactly one Plugins button at ${width}px`)
      const iconGeometry = await plugins.evaluate(button => {
        const outer = button.getBoundingClientRect()
        const svg = button.querySelector('svg').getBoundingClientRect()
        return { horizontal: Math.abs((outer.left + outer.right - svg.left - svg.right) / 2), vertical: Math.abs((outer.top + outer.bottom - svg.top - svg.bottom) / 2), transform: button.querySelector('svg path').getAttribute('transform') }
      })
      assert.ok(iconGeometry.horizontal < 1 && iconGeometry.vertical < 1, `plugin icon is aligned within its button at ${width}px`)
      assert.equal(iconGeometry.transform, 'translate(0 -0.75) scale(1.2)')
      await plugins.click()
      await shipped.getByRole('button', { name: 'Back to chat' }).waitFor()
      const hub = shipped.locator('[data-xharness-plugin-hub]')
      await hub.waitFor()
      await hub.getByText(/No user plugins installed|还没有安装用户插件/).waitFor()
      assert.doesNotMatch(await hub.innerText(), /This device|本机/)
      const pluginIconPath = await hub.locator('.xhph-symbol svg path').getAttribute('d')
      assert.match(pluginIconPath, /^M2\.4 2\.5h3\.05/, 'installed empty state uses the plugin glyph')
      assert.equal(await hub.locator('.xhph-symbol svg').getAttribute('width'), '30')
      if (process.env.PLUGIN_HUB_SCREENSHOT && width === 1200) await shipped.screenshot({ path: process.env.PLUGIN_HUB_SCREENSHOT })
      assert.equal(await hub.getByRole('button', { name: /Install from file|从文件安装/ }).count(), 0)
      assert.doesNotMatch(await hub.innerText(), /Extend what XHarness can do|扩展 XHarness 的能力/)
      await hub.getByRole('tab', { name: /Public|公开/ }).click()
      await hub.getByText(/No plugin catalog imported|尚未导入插件目录/).waitFor()
      const tabAlignment = await hub.evaluate(element => {
        const tab = element.querySelector('#xhph-tab-public')
        const text = document.createRange()
        text.selectNodeContents(tab)
        const heading = element.querySelector('#xhph-installed-title')
        return Math.abs(text.getBoundingClientRect().left - heading.getBoundingClientRect().left)
      })
      assert.ok(tabAlignment < 1, `Public label aligns with section headings at ${width}px`)
      await hub.getByRole('tab', { name: /Personal|个人/ }).click()
      await hub.getByText(/No personal plugins yet|还没有个人插件/).waitFor()
      await hub.getByRole('tab', { name: /Public|公开/ }).click()
      assert.equal(await hub.locator('.xhph-symbol svg path').getAttribute('d'), pluginIconPath)
      const search = hub.getByRole('searchbox', { name: /Search plugins|搜索插件/ })
      await search.fill('nonexistent')
      await hub.getByText(/No matching plugins|没有匹配的插件/).first().waitFor()
      await search.fill('')
      await hub.getByText(/No user plugins installed|还没有安装用户插件/).waitFor()
      assert.equal(await hub.locator('.xhph-detail, .xhph-left').count(), 0, 'no split-pane layout')
      assert.equal(await hub.locator('details, .xhph-step, .xhph-steps').count(), 0, 'no advanced or onboarding steps')
      assert.doesNotMatch(await hub.innerText(), /Plugins you choose to install|Install a local plugin|Review source and permissions|Enable it for tasks|Advanced|内置模块与服务配置/)
      assert.equal(await plugins.getAttribute('aria-current'), 'page')
      if (width === 1200) {
        await shipped.getByRole('button', { name: 'Back to chat' }).click()
        await openAccountSettings(shipped)
        await shipped.getByText('General', { exact: true }).waitFor()
        assert.doesNotMatch(await shipped.locator('body').innerText(), /\nPlugins\n/, 'Plugins is not a Settings section')
        assert.doesNotMatch(await shipped.locator('body').innerText(), /Agent presets|Agent preset|代理预设|智能体预设/, 'Agent preset settings are hidden')
      }
      assert.deepEqual(shippedErrors, [], `no frontend exception at ${width}px`)
      await shipped.close()
    }
  } finally {
    await new Promise(resolveClose => server.close(resolveClose))
  }
  console.log(`plugin center browser / ${browserName}: open, sidebar switch, return-to-chat and no runtime errors passed`)
} finally {
  await browser.close()
}
