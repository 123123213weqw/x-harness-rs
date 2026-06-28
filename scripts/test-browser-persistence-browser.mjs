import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const deps = resolve(process.env.UI_TEST_DEPS ?? '/tmp/xharness-model-ui-tests')
const require = createRequire(resolve(deps, 'package.json'))
const { chromium, webkit } = require('playwright')
const engine = process.env.UI_TEST_BROWSER ?? 'chromium'
const browser = await ({ chromium, webkit })[engine].launch({ headless: true })
try {
  const page = await browser.newPage()
  await page.setContent('<html><body></body></html>')
  const source = readFileSync(new URL('../ui/overrides/workspace-pane.js', import.meta.url), 'utf8')
  await page.addScriptTag({ content: `${source}\nwindow.browserStorage={xhLoadBrowserSpaces,xhSaveBrowserSpaces,xhNextWorkspaceId};` })
  const result = await page.evaluate(async () => {
    const spaces = browserStorage.xhLoadBrowserSpaces(JSON.stringify({ session: {
      activeId: 'browser:9', items: [
        { id: 'browser:9', kind: 'browser', title: 'Site', entries: ['https://example.com/', 'javascript:bad'], position: 1 },
        { id: 'tool', kind: 'tool', title: 'Do not persist' },
      ],
    } }))
    window.saved = []
    window.__TAURI__ = { core: { invoke: async (command, args) => saved.push({ command, args }) } }
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = () => { throw Error('blocked origin storage') }
    try { browserStorage.xhSaveBrowserSpaces(spaces) } finally { Storage.prototype.setItem = original }
    await new Promise(resolve => setTimeout(resolve, 350))
    return { spaces, nextId: browserStorage.xhNextWorkspaceId(spaces), saved }
  })
  assert.equal(result.spaces.session.items.length, 1, 'tool state is not persisted as browser state')
  assert.deepEqual(result.spaces.session.items[0].entries, ['https://example.com/'])
  assert.equal(result.spaces.session.items[0].position, 0)
  assert.equal(result.nextId, 9)
  assert.equal(result.saved[0].command, 'desktop_browser_persist', 'stable app-config persistence must still work when origin storage is blocked')
  assert.equal(JSON.parse(result.saved[0].args.snapshot).session.items.length, 1)
  console.log(`${engine}: browser tab persistence and blocked origin storage passed`)
} finally { await browser.close() }
