// Exercise in-conversation message navigation against the isolated Host fixture.
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
  const history = page.locator('[role="treeitem"]', { hasText: 'Fixture 历史会话' }).first()
  await history.waitFor()
  await history.click()
  const rail = page.getByRole('navigation', { name: 'Messages in this chat' })
  await rail.waitFor()
  assert.equal(await rail.evaluate(el => el.parentElement?.hasAttribute('data-conversation-root')), true,
    'message rail belongs to the conversation, not the sidebar')
  assert.equal(await page.locator('.xh-session-rail').count(), 0, 'incorrect cross-session rail is absent')
  const marks = rail.getByRole('button')
  await page.waitForFunction(() => document.querySelectorAll('.xh-message-rail-item').length > 50)
  const loadedBefore = await page.locator('[data-chat-message-seq]').count()
  assert.ok(await marks.count() > loadedBefore, 'rail indexes user messages beyond the mounted history page')
  if (process.env.UI_TEST_SCREENSHOT) await page.screenshot({ path: process.env.UI_TEST_SCREENSHOT })
  const first = marks.first()
  const seq = await first.getAttribute('data-message-seq')
  assert.ok(seq)
  await first.hover()
  await page.getByRole('tooltip', { name: /^Message 1/ }).waitFor()
  await first.click()
  await page.waitForFunction(targetSeq => {
    const scrollport = document.querySelector('[data-conversation-scroll]')
    const row = document.querySelector(`[data-chat-message-seq="${targetSeq}"]`)
    if (!scrollport || !row) return false
    return Math.abs(row.getBoundingClientRect().top - scrollport.getBoundingClientRect().top - 24) < 50
  }, seq)
  assert.ok(await page.locator('[data-chat-message-seq]').count() > loadedBefore, 'click pages older history into the transcript')
  assert.equal(await first.getAttribute('aria-current'), 'location')
  const sendColors = await page.locator('button[data-xh-send-button]').evaluate(button => {
    const wasDark = document.body.hasAttribute('data-ds-dark-theme')
    document.body.setAttribute('data-ds-dark-theme', '')
    const before = button.disabled
    button.disabled = false
    const enabled = { background: getComputedStyle(button).backgroundColor, foreground: getComputedStyle(button).color }
    button.disabled = true
    const disabled = { background: getComputedStyle(button).backgroundColor, foreground: getComputedStyle(button).color }
    button.disabled = before
    if (!wasDark) document.body.removeAttribute('data-ds-dark-theme')
    return { enabled, disabled }
  })
  assert.deepEqual(sendColors, {
    enabled: { background: 'rgb(212, 212, 212)', foreground: 'rgb(35, 35, 35)' },
    disabled: { background: 'rgb(69, 69, 69)', foreground: 'rgb(155, 155, 155)' },
  }, 'dark send button keeps distinct enabled and disabled neutral contrast')
  assert.deepEqual(errors, [])
  console.log('PASS: message rail stays in current chat, shows user prompts, jumps to chosen message')
} finally { await browser.close() }
