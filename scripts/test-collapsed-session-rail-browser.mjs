// Exercise the shipped session rail in both sidebar widths against the isolated Host fixture.
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, sep, extname } from 'node:path'
import { createRequire } from 'node:module'

const base = resolve(process.env.UI_TEST_DIST ?? 'ui/dist')
const require = createRequire(resolve(process.env.UI_TEST_DEPS ?? '/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps', 'package.json'))
const { chromium } = require('playwright')
const browser = await chromium.launch({
  headless: true,
  ...(process.env.UI_TEST_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.UI_TEST_CHROMIUM_EXECUTABLE }
    : {}),
})
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, locale: 'en-US' })
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
  const first = page.locator('[role="treeitem"][aria-selected="false"]:has(button[aria-label^="Session actions for"])').first()
  await first.waitFor()
  await first.click()
  const rail = page.getByRole('navigation', { name: 'Sessions' })
  await rail.waitFor()
  const buttons = rail.getByRole('button')
  assert.ok(await buttons.count() >= 2, 'rail shows earlier sessions')
  const wideRailBox = await rail.boundingBox()
  const wideRowBox = await first.boundingBox()
  assert.ok(wideRailBox !== null && wideRowBox !== null && wideRailBox.x > wideRowBox.x, 'expanded rail sits to the right of the session list')
  assert.ok(wideRailBox.width <= 22, 'expanded rail remains narrow')
  const active = rail.locator('button[aria-current="page"]')
  assert.equal(await active.count(), 1, 'selected session has one highlighted mark')
  const activeTitle = await active.getAttribute('aria-label')
  const other = rail.locator('button:not([aria-current])').first()
  const otherTitle = await other.getAttribute('aria-label')
  assert.notEqual(otherTitle, activeTitle)
  await other.hover()
  await page.getByRole('tooltip', { name: otherTitle }).waitFor()
  await other.click()
  await page.waitForFunction(title => document.querySelector('.xh-session-rail button[aria-current="page"]')?.getAttribute('aria-label') === title, otherTitle)
  await page.getByRole('button', { name: 'Collapse sidebar' }).click()
  await rail.waitFor()
  assert.ok(await buttons.count() >= 2, 'collapsed rail still shows earlier sessions')
  const collapsedOther = rail.locator('button:not([aria-current])').first()
  const collapsedTitle = await collapsedOther.getAttribute('aria-label')
  await collapsedOther.click()
  await page.waitForFunction(title => document.querySelector('.xh-session-rail button[aria-current="page"]')?.getAttribute('aria-label') === title, collapsedTitle)
  assert.deepEqual(errors, [])
  console.log('PASS: expanded and collapsed rails list sessions, mark current, show title, switch session')
} finally { await browser.close() }
