// Exercise the shipped plugin hub against a deterministic Host RPC fixture.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const deps = resolve(process.env.UI_TEST_DEPS ?? '/tmp/xharness-model-ui-tests')
const require = createRequire(resolve(deps, 'package.json'))
const { chromium } = require('playwright')
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setContent('<div id="root"></div>')
  for (const file of ['react/umd/react.development.js', 'react-dom/umd/react-dom.development.js']) {
    await page.addScriptTag({ path: resolve(deps, 'node_modules', file) })
  }
  await page.addScriptTag({ content: `
    window.__fixture = { catalog: [], installed: [], calls: [] };
    window.confirm = () => true;
    window.__ModuleLoader__ = { load({ factory }) { window.__hub = factory(name => {
      if (name === 'react') return React;
      throw Error('unexpected module ' + name);
    }); } };
  ` })
  await page.addScriptTag({ content: readFileSync(resolve('ui/dist/plugins/@xlang/xharness-client-ui-plugin-hub/client.js'), 'utf8') })
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
              digest: source.source.sha256, enabled: false, capabilities: ['skills'], skills: [{ name: 'demo', description: 'Demo Skill' }] }];
            value = { plugin: store.installed[0] };
          } else if (endpoint === 'plugins/enable' || endpoint === 'plugins/disable') {
            store.installed[0].enabled = endpoint === 'plugins/enable';
            value = { plugin: store.installed[0] };
          } else if (endpoint === 'plugins/uninstall') {
            store.installed = []; value = { ok: true };
          } else throw Error('unexpected endpoint ' + endpoint);
          return { ok: true, value };
        }
      } }; },
      slots: { inject(_name, fn) { fn(); }, register(_spec, view) { component = view; props = { ..._spec.inject(), t: ctx.locale.bind('xharness.pluginHub') }; } },
    };
    window.__hub.apply(ctx);
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(component, props));
  ` })
  const hub = page.locator('[data-xharness-plugin-hub]')
  await hub.waitFor()
  await hub.getByRole('tab', { name: 'Personal' }).click()
  await hub.locator('input[type=file]').setInputFiles({ name: 'marketplace.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ plugins: [{ name: 'demo', version: '1.0', description: 'A demo skill', source: { source: 'url', type: 'zip', url: 'https://example.com/demo.zip', sha256: 'a'.repeat(64) } }] })) })
  await hub.getByText('A demo skill').waitFor()
  assert.ok(await hub.getByRole('tabpanel', { name: 'Personal' }).getByText('demo').count() >= 1)
  await hub.getByRole('button', { name: 'Install', exact: true }).click()
  await hub.getByRole('button', { name: 'Enable', exact: true }).first().waitFor()
  await hub.getByRole('button', { name: 'Enable', exact: true }).first().click()
  await hub.getByRole('button', { name: 'Disable', exact: true }).first().waitFor()
  assert.equal(await page.evaluate(() => window.__fixture.installed[0].enabled), true)
  assert.ok((await page.evaluate(() => window.__fixture.calls)).includes('plugins/enable'))
  assert.deepEqual(errors, [])
  console.log('plugin hub functional: import, catalog scope, install, enable and refresh passed')
} finally {
  await browser.close()
}
