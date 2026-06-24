// Browser-level navigation regression using the shipped AppFrame implementation.
// The Host and its private data are fixtures; no user's running session is touched.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const source = readFileSync(new URL('ui/dist/plugins/@xharness/dsh-client-ui-layout/client.js', root), 'utf8')
const start = source.indexOf('\t\tfunction AppFrame({')
const end = source.indexOf('\n\t\t//#endregion', start)
assert.ok(start >= 0 && end > start, 'shipped AppFrame must remain extractable')
const appFrame = source.slice(start, end)
const deps = resolve(process.env.UI_TEST_DEPS ?? '/tmp/xharness-model-ui-tests')
const require = createRequire(resolve(deps, 'package.json'))
const { chromium } = require('playwright')
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setContent('<div id="root"></div>')
  for (const file of ['react/umd/react.development.js', 'react-dom/umd/react-dom.development.js']) {
    await page.addScriptTag({ path: resolve(deps, 'node_modules', file) })
  }
  await page.addScriptTag({ content: `
    const react=React;
    const react_jsx_runtime={jsx:(type,props,key)=>React.createElement(type,{...props,key}),jsxs:(type,props,key)=>React.createElement(type,{...props,key}),Fragment:React.Fragment};
    const AppFrame_module_css_default={frame:'frame',sidebarCol:'sidebar',centerCol:'center',detailsCol:'details',overlayLayer:'overlay'};
    const SIDEBAR_AUTO_COLLAPSE=1024;
    const computeColumns=(viewport,sidebar,details)=>({sidebar:sidebar||56,center:viewport-(sidebar||56)-details,details});
    const CenterColumn=props=>React.createElement('div',{className:'center'},props.children);
    const DetailsColumn=props=>React.createElement('div',{className:'details'},props.children);
    const DragHandle=()=>null;
    ${appFrame}
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
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(AppFrame,{useStore:f=>f(panels),useSessions:f=>f(sessions),actions,renderSlot}));
  ` })
  await page.getByText('Chat content').waitFor()
  await page.getByRole('button', { name: 'Plugins' }).click()
  await page.getByText('Plugin inventory').waitFor()
  assert.equal(await page.getByText('Chat content').count(), 0, 'chat is replaced, not overlaid')
  await page.getByRole('button', { name: 'Search' }).click()
  await page.getByText('Chat content').waitFor()
  await page.getByRole('button', { name: 'Plugins' }).click()
  await page.getByText('Plugin inventory').waitFor()
  await page.getByRole('button', { name: 'Back to chat' }).click()
  await page.getByText('Chat content').waitFor()
  assert.deepEqual(errors, [])

  // Load the actual shipped bundles at both sidebar widths. This catches
  // duplicate responsive controls that AppFrame-only fixtures cannot see.
  const dist = resolve(fileURLToPath(root), 'ui/dist')
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
      response.writeHead(200, { 'Content-Type': mime }).end(body)
    } catch {
      response.writeHead(404).end()
    }
  })
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  try {
    const url = `http://127.0.0.1:${server.address().port}/`
    for (const width of [800, 1200]) {
      const shipped = await browser.newPage({ viewport: { width, height: 700 } })
      const shippedErrors = []
      shipped.on('pageerror', error => shippedErrors.push(error.message))
      await shipped.goto(url, { waitUntil: 'domcontentloaded' })
      const plugins = shipped.getByRole('button', { name: 'Plugins', exact: true })
      await plugins.waitFor()
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
      await hub.getByText(/Plugin catalog is not connected yet|插件目录尚未接入/).waitFor()
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
      await hub.getByText(/No matching plugins|没有匹配的插件/).waitFor()
      await search.fill('')
      await hub.getByText(/No user plugins installed|还没有安装用户插件/).waitFor()
      assert.equal(await hub.locator('.xhph-detail, .xhph-left').count(), 0, 'no split-pane layout')
      assert.equal(await hub.locator('details, .xhph-step, .xhph-steps').count(), 0, 'no advanced or onboarding steps')
      assert.doesNotMatch(await hub.innerText(), /Plugins you choose to install|Install a local plugin|Review source and permissions|Enable it for tasks|Advanced|内置模块与服务配置/)
      assert.equal(await plugins.getAttribute('aria-current'), 'page')
      if (width === 1200) {
        await shipped.getByRole('button', { name: 'Back to chat' }).click()
        await shipped.getByRole('button', { name: 'Settings', exact: true }).first().click()
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
  console.log('plugin center browser: open, sidebar switch, return-to-chat and no runtime errors passed')
} finally {
  await browser.close()
}
