// Real browser stacking/hit-testing with shipped chat overlay CSS; no user data.
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(resolve(process.env.UI_TEST_DEPS ?? repo, 'package.json'))
const { chromium, webkit } = require('playwright')
const engine = process.env.UI_TEST_BROWSER ?? 'chromium'
assert.ok(['chromium', 'webkit'].includes(engine))
const bundle = readFileSync(join(repo, 'ui/dist/plugins/@deepseek-ai/dsh-client-ui-layout/client.js'), 'utf8')
const line = bundle.split('\n').find(line => line.includes('const css') && line.includes('overlayLayer'))
assert.ok(line, 'Shipped chat layout overlay CSS must exist')
const css = JSON.parse(line.trim().match(/^const \S+ = (".*");$/)[1])
const overlayClass = css.match(/\.([\w-]*overlayLayer)\s*\{/)[1]
const source = readFileSync(join(repo, 'ui/desktop/updater.js'), 'utf8')
const output = process.env.UI_TEST_OUTPUT
if (output) mkdirSync(output, { recursive: true })
const browser = await ({ chromium, webkit }[engine]).launch({
  headless: true,
  ...(process.env.UI_TEST_EXECUTABLE ? { executablePath: process.env.UI_TEST_EXECUTABLE } : {}),
})
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  let cases = 0
  for (const width of [1254, 600]) {
    await page.setViewportSize({ width, height: 768 })
    await page.setContent(`<style>
      html,body{height:100%;margin:0;font:15px system-ui;background:#f6f7f8}
      ${css}
      main{height:100%;padding:32px 90px;box-sizing:border-box}
      aside{position:absolute;left:0;top:0;bottom:0;width:64px;background:#e8eaed}
      #settings{position:absolute;left:8px;bottom:12px}
      #chat-overlay{background:#ffffffee;align-items:center;justify-content:center;pointer-events:auto}
    </style><aside><button id="settings">设置</button></aside>
    <main><h1>Chat</h1><p>Conversation remains the primary interface.</p></main>
    <div id="chat-overlay" class="${overlayClass}" style="display:none"><h2>Chat settings / overlay</h2></div>`)
    await page.evaluate(() => {
      window.calls = []
      window.remote = { seq: 1, phase: 'available', version: '9.9.9' }
      window.__TAURI__ = {
        core: { invoke: async command => {
          calls.push(command)
          return command === 'desktop_status' ? { updaterConfigured: true } : remote
        } },
        event: { listen: async (_event, callback) => { window.emitUpdate = callback; return () => {} } },
      }
    })
    await page.addScriptTag({ content: source })
    const host = page.locator('#xharness-desktop-updater')
    await host.waitFor({ state: 'visible' })
    const toggle = host.locator('.toggle')
    const panel = host.locator('.panel')
    for (const [seq, phase] of [[2, 'available'], [3, 'downloaded']]) {
      await page.evaluate(({ seq, phase }) => {
        remote = { seq, phase, version: '9.9.9' }
        emitUpdate({ payload: remote })
      }, { seq, phase })
      for (const expanded of [false, true]) {
        if ((await toggle.getAttribute('aria-expanded')) !== String(expanded)) await toggle.click()
        const box = await (expanded ? panel : toggle).boundingBox()
        assert.ok(box?.width > 0)
        const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
        assert.equal(await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.id, point), 'xharness-desktop-updater', 'Normal updater must remain reachable')
        await page.locator('#chat-overlay').evaluate(node => { node.style.display = 'flex' })
        if (output && expanded && phase === 'available') await page.screenshot({ path: join(output, `${engine}-${width}-chat-overlay.png`) })
        assert.equal(await page.evaluate(p => Boolean(document.elementFromPoint(p.x, p.y)?.closest('#chat-overlay')), point), true,
          `${engine} ${width} ${phase} expanded=${expanded}: updater must stay below chat overlay`)
        await page.locator('#chat-overlay').evaluate(node => { node.style.display = 'none' })
        cases++
      }
      await toggle.click()
    }
    await page.locator('#settings').click()
    assert.equal(await host.evaluate(node => getComputedStyle(node).zIndex), 'auto')
    assert.equal(await page.evaluate(() => calls.includes('desktop_install_update')), false)
    if (output) await page.screenshot({ path: join(output, `${engine}-${width}-chat.png`) })
  }
  assert.deepEqual(errors, [])
  console.log(`${engine}: ${cases} real updater/chat stacking cases passed; no installation invoked.`)
} finally { await browser.close() }
