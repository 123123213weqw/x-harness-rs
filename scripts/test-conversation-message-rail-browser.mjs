// Exercise in-conversation message navigation against the isolated Host fixture.
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, sep, extname } from 'node:path'
import { createRequire } from 'node:module'

const base = resolve(process.env.UI_TEST_DIST ?? 'ui/dist')
const require = createRequire(resolve(process.env.UI_TEST_DEPS ?? '/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps', 'package.json'))
const engine = process.env.UI_TEST_BROWSER ?? 'chromium'
assert.ok(['chromium', 'webkit'].includes(engine))
const browser = await require('playwright')[engine].launch({
  headless: true,
  ...(engine === 'chromium' && process.env.UI_TEST_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.UI_TEST_CHROMIUM_EXECUTABLE }
    : {}),
})
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, locale: 'en-US' })
  page.setDefaultTimeout(15_000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.hostname !== '127.0.0.1') return route.abort('blockedbyclient')
    const local = resolve(base, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname))
    if (!local.startsWith(base + sep) || !existsSync(local)) return route.fulfill({ status: 404, body: 'fixture asset missing' })
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.wasm': 'application/wasm' }
    return route.fulfill({ body: readFileSync(local), contentType: types[extname(local)] ?? 'application/octet-stream' })
  })
  await page.goto('http://127.0.0.1:39187/?fixture=1')
  const history = page.locator('[role="treeitem"]', { hasText: 'Fixture 历史会话' }).first()
  await history.waitFor()
  await history.click()
  const rail = page.getByRole('navigation', { name: 'Messages in this chat' })
  await rail.waitFor()
  assert.equal(await rail.evaluate(el => el.parentElement?.hasAttribute('data-conversation-root')), true,
    'message rail belongs to the conversation, not the sidebar')
  assert.equal(await page.locator('.xh-session-rail').count(), 0, 'incorrect cross-session rail is absent')
  const marks = rail.getByRole('button')
  const initialCount = await marks.count()
  assert.ok(initialCount >= 3, 'one rail mark per loaded user message')
  const older = page.getByRole('button', { name: 'Load earlier' })
  // A real reader first scrolls away from live bottom-follow. Programmatic
  // actionability scrolling alone does not establish that user intent in WebKit.
  await page.locator('[data-conversation-scroll]').hover()
  await page.mouse.wheel(0, -10000)
  await older.click()
  await page.waitForFunction(count => document.querySelectorAll('.xh-message-rail-item').length > count, initialCount)
  if (process.env.UI_TEST_SCREENSHOT) await page.screenshot({ path: process.env.UI_TEST_SCREENSHOT })
  const first = marks.first()
  const key = await first.getAttribute('data-message-key')
  assert.ok(key)
  await first.hover()
  await page.getByRole('tooltip', { name: /^Message 1/ }).waitFor()
  await first.click()
  await page.waitForFunction(targetKey => {
    const scrollport = document.querySelector('[data-conversation-scroll]')
    const row = [...document.querySelectorAll('[data-chat-anchor-key]')]
      .find(element => element.getAttribute('data-chat-anchor-key') === targetKey)
    if (!scrollport || !row) return false
    return Math.abs(row.getBoundingClientRect().top - scrollport.getBoundingClientRect().top - 24) < 50
  }, key)
  assert.equal(await first.getAttribute('aria-current'), 'location')
  assert.deepEqual(errors, [])
  console.log(engine + ': PASS: message rail stays in current chat, shows user prompts, jumps to chosen message')
} finally { await browser.close() }
