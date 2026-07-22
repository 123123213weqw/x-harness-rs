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
  const errors = []
  page.on('pageerror', error => {if(error.message!=='owned feature fixture: stop Host boot')errors.push(error.message)})
  await installOwnedViewPlatform(page,process.env.UI_TEST_IMPL==='legacy'?'legacy':'source')
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
  await hub.locator('input[type=file]').setInputFiles({ name: 'marketplace.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ plugins: [{ name: 'demo', version: '1.0', description: 'A demo skill', source: { source: 'url', type: 'zip', url: 'https://example.com/demo.zip', sha256: 'a'.repeat(64) } }] })) })
  await hub.getByText('A demo skill').waitFor()
  assert.ok(await hub.getByRole('tabpanel', { name: 'Personal' }).getByText('demo').count() >= 1)
  await page.evaluate(() => window.__fixture.confirm = false)
  await hub.getByRole('button', { name: 'Install', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('.xhph-actions button').disabled)
  assert.equal(await page.evaluate(() => window.__fixture.calls.includes('plugins/install')), false)
  await page.evaluate(() => window.__fixture.confirm = true)
  await hub.getByRole('button', { name: 'Install', exact: true }).click()
  await hub.getByRole('button', { name: 'Enable', exact: true }).first().waitFor()
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
  assert.equal(await hub.locator('.xhph-icon img').count(), 0, 'main initials have no WIP bundled artwork')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({engine:browserName,implementation:process.env.UI_TEST_IMPL??'canonical',actualPlatform:true,initialPixelsSha256,pageErrors:errors}))
  console.log(`plugin hub functional / ${browserName} / ${process.env.UI_TEST_IMPL ?? 'canonical'}: main import, install/cancel, Skill enable, MCP environment-source consent, metadata refresh, uninstall and keyboard tabs passed`)
} finally {
  await browser.close()
}
