// Exercise the shipped collapsed sidebar against the isolated in-process Host fixture.
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
  await page.getByRole('button', { name: 'Collapse sidebar' }).click()
  const rail = page.getByRole('navigation', { name: 'Sessions' })
  await rail.waitFor()
  const buttons = rail.getByRole('button')
  assert.ok(await buttons.count() >= 2, 'rail shows earlier sessions')
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
  assert.deepEqual(errors, [])
  console.log('PASS: collapsed rail lists sessions, marks current, shows title, switches session')
} finally { await browser.close() }
