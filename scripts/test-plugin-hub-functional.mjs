// Exercise the shipped plugin hub against a deterministic Host RPC fixture.
import assert from 'node:assert/strict'
import {installOwnedViewPlatform} from './fixtures/owned-view-platform-browser.mjs'
import {createHash} from 'node:crypto'
import { ownedViewModuleTestInput } from './owned-view-module-test-input.mjs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const deps = resolve(process.env.UI_TEST_DEPS ?? '/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps')
const require = createRequire(resolve(deps, 'package.json'))
const browserName = process.env.UI_TEST_BROWSER ?? 'chromium'
assert.ok(['chromium', 'webkit'].includes(browserName))
const hubSource = ownedViewModuleTestInput('@xlang/xharness-client-ui-plugin-hub')
const browser = await require('playwright')[browserName].launch({ headless: true })
try {
  const page = await browser.newPage()
  page.setDefaultTimeout(20000)
  const iconRequests = []
  const errors = []
  page.on('pageerror', error => {if(error.message!=='owned feature fixture: stop Host boot')errors.push(error.message)})
  await installOwnedViewPlatform(page,process.env.UI_TEST_IMPL==='legacy'?'legacy':'source')
  await page.route('https://icons.example.test/**', route => {
    iconRequests.push(route.request().url())
    return route.request().url().endsWith('/broken.svg')
      ? route.fulfill({status:404,body:'missing'})
      : route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#38bdf8"/></svg>'})
  })
  await page.evaluate(()=>document.body.innerHTML='<div id="root"></div>')
  await page.addScriptTag({ content: `
    window.__fixture = { catalog: [], installed: [], calls: [], confirm: true };
    window.confirm = message => { window.__fixture.confirmMessage = message; return window.__fixture.confirm; };
    window.__modules = {};
    window.__ModuleLoader__ = { load({ id, factory }) { window.__modules[id] = factory(name => {
      if (name === 'react') return React;
      if (window.__modules[name]) return window.__modules[name];
      throw Error('unexpected module ' + name);
    }); } };
  ` })
  if (hubSource.includes('@xlang/xharness-client-plugin-api')) await page.addScriptTag({ content: ownedViewModuleTestInput('@xlang/xharness-client-plugin-api') })
  await page.addScriptTag({ content: hubSource })
  await page.addScriptTag({ content: `
    let labels = {};
    let component, props;
    const ctx = {
      effect(fn) { fn(); },
      locale: { register(_ns, value) { labels = value.en; }, bind() { return key => labels[key] ?? key; } },
      get(name) { if (name !== 'connection') throw Error(name); return { rpc: {
        async call(channel, endpoint, payload) {
          if (channel !== '/api') throw Error(channel);
          const store = window.__fixture;
          store.calls.push(endpoint);
          const args = payload.args;
          let value;
          if (endpoint === 'plugins/catalog') value = { plugins: store.catalog };
          else if (endpoint === 'plugins/installed') value = { plugins: store.installed };
          else if (endpoint === 'plugins/updates') value = { updates: [] };
          else if (endpoint === 'plugins/importCatalog') {
            store.catalog = JSON.parse(args.content).plugins.map(item => ({ ...item, scope: args.scope }));
            value = { plugins: store.catalog };
          } else if (endpoint === 'plugins/install') {
            const source = store.catalog.find(item => item.name === args.name);
            store.installed = [{ name: source.name, version: source.version, description: source.description,
              digest: source.source.sha256, enabled: false, mcpEnabled: false, capabilities: ['skills', 'mcp'], skills: [{ name: 'demo', description: 'Demo Skill', relativePath: 'skills/demo/SKILL.md', sha256: 'b'.repeat(64) }] }];
            value = { plugin: store.installed[0] };
          } else if (endpoint === 'plugins/enable' || endpoint === 'plugins/disable') {
            store.installed[0].enabled = endpoint === 'plugins/enable';
            value = { plugin: store.installed[0] };
          } else if (endpoint === 'plugins/uninstall') {
            store.installed = []; value = { ok: true };
          } else if (endpoint === 'plugins/mcpPreview') {
            value = { servers: [{ server: 'local', command: 'node', args: ['server.js'], envKeys: ['TOKEN'], envSources: { TOKEN: 'Host environment: DEEPSEEK_API_KEY' } }] };
          } else if (endpoint === 'plugins/mcpEnable' || endpoint === 'plugins/mcpDisable') {
            store.installed[0].mcpEnabled = endpoint === 'plugins/mcpEnable';
            value = { plugin: store.installed[0] };
          } else throw Error('unexpected endpoint ' + endpoint);
          return { ok: true, value };
        }
      } }; },
      slots: { inject(_name, fn) { fn(); }, register(_spec, view) { component = view; props = { ..._spec.inject(), t: ctx.locale.bind('xharness.pluginHub') }; } },
    };
    window.__modules['@xlang/xharness-client-ui-plugin-hub'].apply(ctx);
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(component, props));
  ` })
  const hub = page.locator('[data-xharness-plugin-hub]')
  await hub.waitFor()
  await hub.getByText('No plugin catalog imported').waitFor()
  assert.equal(await hub.getByRole('combobox').count(), 0, 'main has no WIP source selector')
  assert.deepEqual(await page.evaluate(() => window.__fixture.calls), ['plugins/catalog', 'plugins/installed', 'plugins/updates'], 'main startup only reads metadata')
  await page.evaluate(()=>document.fonts.ready);const initialPixelsSha256=createHash('sha256').update(await hub.screenshot({animations:'disabled'})).digest('hex')
  await hub.getByRole('tab', { name: 'Personal' }).focus()
  await page.keyboard.press('ArrowLeft')
  assert.equal(await hub.getByRole('tab', {name: 'Public'}).getAttribute('aria-selected'), 'true')
  await page.keyboard.press('End')
  assert.equal(await hub.getByRole('tab', {name: 'Personal'}).getAttribute('aria-selected'), 'true')
  await hub.getByRole('tab', { name: 'Personal' }).click()
  const demo = { name: 'demo', version: '1.0', description: 'A demo skill', icon:'https://icons.example.test/demo.svg', source: { source: 'url', type: 'zip', url: 'https://example.com/demo.zip', sha256: 'a'.repeat(64) } }
  const supportsCatalogIcons = process.env.UI_TEST_IMPL !== 'legacy'
  await hub.locator('input[type=file]').setInputFiles({ name: 'marketplace.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ plugins: [demo] })) })
  await hub.getByText('A demo skill').waitFor()
  assert.ok(await hub.getByRole('tabpanel', { name: 'Personal' }).getByText('demo').count() >= 1)
  if (supportsCatalogIcons) {
    await page.waitForFunction(() => document.querySelector('.xhph-icon img')?.naturalWidth === 32)
    assert.equal(await hub.locator('.xhph-icon img').getAttribute('referrerpolicy'), 'no-referrer')
  }
  await page.evaluate(() => window.__fixture.confirm = false)
  await hub.getByRole('button', { name: 'Install', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('.xhph-actions button').disabled)
  assert.equal(await page.evaluate(() => window.__fixture.calls.includes('plugins/install')), false)
  await page.evaluate(() => window.__fixture.confirm = true)
  await hub.getByRole('button', { name: 'Install', exact: true }).click()
  await hub.getByRole('button', { name: 'Enable', exact: true }).first().waitFor()
  if (supportsCatalogIcons) {
    await page.waitForFunction(() => document.querySelector('.xhph-installed .xhph-icon img')?.naturalWidth === 32)
    assert.equal(await hub.locator('.xhph-installed .xhph-icon img').getAttribute('src'),demo.icon,'installed card inherits catalog icon without changing installed wire schema')
  }
  await hub.getByRole('button', { name: 'Enable', exact: true }).first().click()
  await hub.getByRole('button', { name: 'Disable', exact: true }).first().waitFor()
  assert.equal(await page.evaluate(() => window.__fixture.installed[0].enabled), true)
  await hub.getByText('demo', { exact: true }).first().click()
  await hub.getByRole('button', { name: 'Allow MCP', exact: true }).click()
  await hub.getByRole('button', { name: 'Disable MCP', exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.__fixture.installed[0].mcpEnabled), true)
  assert.match(await page.evaluate(() => window.__fixture.confirmMessage), /TOKEN ← Host environment: DEEPSEEK_API_KEY/)
  assert.ok((await page.evaluate(() => window.__fixture.calls)).includes('plugins/enable'))
  await hub.getByRole('button', { name: 'Refresh', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('.xhph-actions button').disabled)
  assert.equal(await page.evaluate(() => window.__fixture.calls.includes('plugins/refreshCatalog')), false, 'main Refresh is a metadata reload, not new Host endpoint')
  await hub.getByRole('button', { name: 'Uninstall', exact: true }).click()
  await hub.getByText('No user plugins installed').waitFor()
  assert.equal(await page.evaluate(() => window.__fixture.installed.length), 0)
  if (supportsCatalogIcons) {
    assert.equal(await hub.locator('.xhph-icon img').count(), 1, 'catalog SVG remains after uninstall')
    const importIcons = async plugins => {
      await hub.locator('input[type=file]').setInputFiles({name:'icons.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({plugins}))})
      await page.waitForFunction(() => !document.querySelector('.xhph-actions button').disabled)
    }
    await importIcons([{...demo,icon:'https://icons.example.test/broken.svg'},{...demo,name:'missing',icon:null},{...demo,name:'unsafe',icon:'javascript:alert(1)'},{...demo,name:'malformed',icon:'https://['},{...demo,name:'credentials',icon:'https://user:password@icons.example.test/private.svg'}])
    await page.waitForFunction(() => document.querySelectorAll('.xhph-item').length === 5 && document.querySelectorAll('.xhph-icon img').length === 0)
    assert.deepEqual(await hub.locator('.xhph-icon').allTextContents(),['D','M','U','M','C'],'bad URLs and failed images fall back without broken-image glyphs')
    assert.equal(iconRequests.filter(url=>url.endsWith('/broken.svg')).length,1,'no failure retry loop')
    assert.equal(iconRequests.some(url=>url.includes('/private.svg')),false,'credential-bearing metadata does not make a request')
    await importIcons([{...demo,icon:'https://icons.example.test/recovered.svg'}])
    await page.waitForFunction(() => document.querySelector('.xhph-icon img')?.naturalWidth === 32)
    assert.match(await hub.locator('.xhph-icon img').getAttribute('src'),/recovered\.svg$/,'new URL recovers an existing failed card')
    await page.evaluate(()=>document.fonts.ready)
    const box = await hub.locator('.xhph-icon img').boundingBox()
    assert.equal(box.width,42);assert.equal(box.height,42)
  } else assert.equal(await hub.locator('.xhph-icon img').count(), 0, 'frozen reference uses initials')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({engine:browserName,implementation:process.env.UI_TEST_IMPL??'canonical',actualPlatform:true,initialPixelsSha256,pageErrors:errors}))
  console.log(`plugin hub functional / ${browserName} / ${process.env.UI_TEST_IMPL ?? 'canonical'}: main import, install/cancel, Skill enable, MCP environment-source consent, metadata refresh, uninstall and keyboard tabs passed`)
} finally {
  await browser.close()
}
