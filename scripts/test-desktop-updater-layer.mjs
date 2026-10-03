// Actual shipped layout + sticky composer CSS and the desktop bridge; no user data.
import { verifyArtifact, shippedUnitValue } from './fixtures/shipped-source-values.mjs'
import assert from 'node:assert/strict'
import { scriptAsset } from './fixtures/script-asset-test.mjs'
import { readFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(resolve(process.env.UI_TEST_DEPS ?? repo, 'package.json'))
const { chromium, webkit } = require('playwright')
const engine = process.env.UI_TEST_BROWSER ?? 'chromium'
assert.ok(['chromium', 'webkit'].includes(engine))
const layout = verifyArtifact('@xharness/dsh-client-ui-layout')
const css = shippedUnitValue(layout, 'src/modules/layout/AppFrame.css')
const layoutClasses = shippedUnitValue(layout, 'src/modules/layout/AppFrame.styles.js')
const conversation = verifyArtifact('@xharness/dsh-client-ui-conversation')
const composerCss = shippedUnitValue(conversation, 'src/modules/conversation/skeleton/ConversationRoot.css')
const composerClasses = shippedUnitValue(conversation, 'src/modules/conversation/skeleton/ConversationRoot.styles.js')
assert.ok(css.includes('overlayLayer') && composerCss.includes('position:sticky'), 'Real shell and composer layers required')
// Baseline override lets the regression demonstrate failure against an installed old bridge.
const source = process.env.UI_TEST_UPDATER_SOURCE
  ? readFileSync(process.env.UI_TEST_UPDATER_SOURCE, 'utf8')
  : scriptAsset('desktop-updater.js')
const output = process.env.UI_TEST_OUTPUT
if (output) mkdirSync(output, { recursive: true })
const browser = await ({ chromium, webkit }[engine]).launch({
  headless: true,
  ...(process.env.UI_TEST_EXECUTABLE ? { executablePath: process.env.UI_TEST_EXECUTABLE } : {}),
})
try {
  const page = await browser.newPage()
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  let cases = 0
  for (const { width, height } of [{ width: 1254, height: 768 }, { width: 600, height: 768 }, { width: 360, height: 480 }]) {
    for (const sidebar of [56, 260]) {
      await page.setViewportSize({ width, height })
      await page.setContent(`<style>
        html,body{height:100%;margin:0;font:15px system-ui;background:#f6f7f8}
        :root{--dsw-alias-bg-base:#f6f7f8;--dsw-specific-sidebar-fill:#e8eaed}
        ${css} ${composerCss}
        .${layoutClasses.sidebarCol}{position:relative}
        #settings{position:absolute;left:8px;bottom:12px}
        .${composerClasses.viewArea}{min-height:1200px!important;padding:24px}
        .${composerClasses.composerSeat}{min-height:200px;padding:40px 16px 16px;box-sizing:border-box}
        textarea{width:100%;height:120px;box-sizing:border-box}
        #chat-overlay{display:none}
        #shell-scrim{position:absolute;inset:0;background:#ffffffee}
      </style>
      <div class="${layoutClasses.frame}" style="grid-template-columns:${sidebar}px 1fr">
        <aside class="${layoutClasses.sidebarCol}"><button id="settings">设置</button></aside>
        <main class="${layoutClasses.centerCol}">
          <div class="${composerClasses.root}" data-phase="active">
            <div class="${composerClasses.scrollBody}">
              <section class="${composerClasses.viewArea}"><h1>Chat</h1><p>Conversation remains the primary interface.</p></section>
              <footer class="${composerClasses.composerSeat}"><textarea aria-label="Message the agent"></textarea></footer>
            </div>
          </div>
        </main>
        <div id="chat-overlay" class="${layoutClasses.overlayLayer}"><div id="shell-scrim" role="dialog" aria-label="Chat settings / approval"></div></div>
      </div>`)
      await page.evaluate(() => {
        window.calls = []
        window.remote = { seq: 1, phase: 'available', version: '9.9.9' }
        window.escapeLeaked = false
        window.overlayClicks = 0
        document.addEventListener('keydown', event => { if (event.key === 'Escape') escapeLeaked = true })
        document.querySelector('#shell-scrim').addEventListener('click', () => overlayClicks++)
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
      const toggle = host.locator('.toggle'), panel = host.locator('.panel')
      const assertReachable = async (locator, message) => {
        await locator.scrollIntoViewIfNeeded()
        const box = await locator.boundingBox()
        assert.ok(box?.width > 0 && box?.height > 0, message)
        const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
        assert.equal(await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.id, point), 'xharness-desktop-updater', message)
        return point
      }
      let seq = 1, fixtureClicks = 0
      for (const phase of ['available', 'downloaded', 'downloading', 'error']) {
        await page.evaluate(({ seq, phase }) => {
          remote = { seq, phase, version: '9.9.9', downloaded: 51, total: 100,
            ...(phase === 'error' ? { retryAction: 'download', message: 'offline' } : {}) }
          emitUpdate({ payload: remote })
        }, { seq: ++seq, phase })
        await assertReachable(toggle, 'Collapsed updater icon remains reachable')
        await toggle.click()
        await panel.waitFor({ state: 'visible' })
        // Check actual buttons, not just the panel centre: the gradient covers its bottom.
        for (const name of ['.close', '.action', '.diagnostics']) {
          await assertReachable(host.locator(name), `${engine} ${width} sidebar=${sidebar} ${phase}: ${name} must win over sticky composer`)
        }
        assert.equal(await panel.getAttribute('role'), 'dialog', 'Shadow panel exposes dialog semantics')
        assert.equal(await panel.getAttribute('aria-modal'), 'false', 'Updater is nonmodal and must not lock the conversation')
        const point = await assertReachable(host.locator('.diagnostics'), 'Bottom action reachable before opening shared overlay')
        if (output && phase === 'available' && sidebar === 56) await page.screenshot({ path: join(output, `${engine}-${width}-updater.png`) })
        await page.locator('#chat-overlay').evaluate(node => { node.style.display = 'block' })
        assert.equal(await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.id, point), 'shell-scrim', 'Shell overlay must win over the updater')
        const toggleBox = await toggle.boundingBox()
        assert.equal(await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.id,
          { x: toggleBox.x + 10, y: toggleBox.y + 10 }), 'shell-scrim', 'Shared overlay covers collapsed icon too')
        await page.mouse.click(point.x, point.y)
        assert.equal(await page.evaluate(() => overlayClicks), ++fixtureClicks, 'No click-through into updater')
        await page.locator('#chat-overlay').evaluate(node => { node.style.display = 'none' })
        if (phase === 'downloaded') {
          await host.locator('.action').click()
          await host.locator('.confirm').waitFor({ state: 'visible' })
          await assertReachable(host.locator('.later'), 'Confirmation dismiss remains reachable')
          await host.locator('.later').click()
        }
        await host.locator('.close').focus()
        await host.locator('.close').press('Escape')
        assert.equal(await panel.isVisible(), false)
        assert.equal(await toggle.evaluate(node => node.getRootNode().activeElement === node), true, 'Escape restores focus to update toggle')
        assert.equal(await page.evaluate(() => escapeLeaked), false, 'Escape must not close another app panel')
        cases++
      }
      // Large notes + confirmation must stay within a short viewport, with a scrollable panel.
      await page.evaluate(seq => emitUpdate({ payload: { seq, phase: 'downloaded', notes: 'Release notes\n'.repeat(80) } }), ++seq)
      await toggle.click()
      await host.locator('.action').click()
      const bounds = await panel.boundingBox()
      assert.ok(bounds.y >= 15 && bounds.y + bounds.height <= height - 109, 'Whole panel stays on screen')
      await assertReachable(host.locator('.diagnostics'), 'Long panel scrolls to bottom action')
      await host.locator('.close').click()
      await page.locator('#settings').click()
      await page.getByRole('textbox', { name: 'Message the agent' }).fill('draft stays editable')
      assert.equal(await page.evaluate(() => calls.includes('desktop_install_update')), false, 'Layer regression must never install/restart')
      assert.equal(await host.evaluate(node => getComputedStyle(node).zIndex), '11')
    }
  }
  assert.deepEqual(errors, [])
  assert.equal(cases, 24)
  console.log(`${engine}: ${cases} actual sticky-composer/updater/shell stacking cases + short viewport, long notes, confirmation, Escape/focus, editable draft passed; no installation invoked.`)
} finally { await browser.close() }
