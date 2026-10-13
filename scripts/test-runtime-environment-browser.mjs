/** Genuine generated platform/module graph, built-in fixture transport only. */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, sep } from 'node:path'

const deps = process.env.UI_TEST_DEPS ?? '/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps'
const engine = process.env.UI_TEST_BROWSER ?? 'chromium'
const require = createRequire(resolve(deps, 'package.json'))
assert.ok(['chromium', 'webkit'].includes(engine))
const base = resolve('ui/dist'), evidence = resolve('dist/runtime-environment-20261011')
mkdirSync(evidence, { recursive: true })
const browser = await require('playwright')[engine].launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, locale: 'en-US' })
  page.setDefaultTimeout(20000)
  const errors = [], requests = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => {
    const url = new URL(route.request().url()); requests.push(url.pathname)
    if (url.hostname !== '127.0.0.1') return route.abort('blockedbyclient')
    const path = resolve(base, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname))
    if (!path.startsWith(base + sep) || !existsSync(path)) return route.fulfill({ status: 404, body: 'fixture asset missing' })
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.wasm': 'application/wasm' }
    return route.fulfill({ body: readFileSync(path), contentType: types[path.match(/\.[^./]+$/)?.[0]] ?? 'application/octet-stream' })
  })
  await page.goto('http://127.0.0.1:39187/?fixture=1')
  const newSession = page.getByRole('button', { name: 'New session', exact: true }).filter({ hasText: /^New Session$/ })
  await newSession.waitFor({ timeout: 60000 })
  await page.locator('[data-xh-startup-exit]').waitFor({ state: 'detached' })
  await newSession.click()
  const trigger = page.getByRole('button', { name: 'Choose execution environment', exact: true })
  await trigger.waitFor()
  assert.equal(await trigger.isEnabled(), true)
  assert.equal(await trigger.innerText(), 'Local')
  const workspace = page.getByRole('button', { name: 'Choose workspace', exact: true })
  assert.equal(await trigger.getAttribute('class'), await workspace.getAttribute('class'))
  for (const dark of [false, true]) {
    await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), dark)
    const styles = await page.evaluate(() => {
      const env = document.querySelector('[data-xh-runtime-environment]'), workspace = document.querySelector('[aria-label="Choose workspace"]')
      const keys = ['fontFamily', 'fontSize', 'fontWeight', 'color', 'lineHeight', 'gap', 'padding', 'borderRadius', 'minHeight']
      return keys.map(key => [key, getComputedStyle(env)[key], getComputedStyle(workspace)[key]])
    })
    for (const [key, env, workspace] of styles) assert.equal(env, workspace, key)
  }
  await trigger.press('ArrowDown')
  const local = page.getByRole('menuitem', { name: 'Local', exact: true })
  const cloud = page.getByRole('menuitem', { name: /Cloud.*not connected/ })
  await cloud.waitFor()
  assert.equal(await cloud.isDisabled(), true)
  await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem')
  assert.equal(await local.evaluate(el => el === document.activeElement), true)
  await local.press('End'); assert.equal(await local.evaluate(el => el === document.activeElement), true)
  await local.press('Escape'); await page.getByRole('menu').waitFor({ state: 'detached' })
  assert.equal(await trigger.evaluate(el => el === document.activeElement), true)
  await trigger.click(); await cloud.waitFor(); await workspace.click()
  await page.getByRole('menuitem', { name: 'Local', exact: true }).waitFor({ state: 'detached' })
  await page.keyboard.press('Escape')
  await trigger.click(); await local.waitFor(); await local.press('Tab')
  await page.getByRole('menu').waitFor({ state: 'detached' })
  await trigger.click(); await local.waitFor(); await local.press('Enter')
  await page.getByRole('menu').waitFor({ state: 'detached' })
  assert.equal(await trigger.innerText(), 'Local')
  await page.setViewportSize({ width: 520, height: 780 })
  await trigger.click(); await cloud.waitFor()
  const bounds = await page.getByRole('menu').boundingBox()
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 520, 'portal menu stays inside narrow viewport')
  await page.screenshot({ path: resolve(evidence, engine + '-cloud-menu.png'), animations: 'disabled' })
  assert.ok(requests.some(path => path.includes('/@xlang/xharness-client-ui-runtime/')))
  assert.ok(!requests.some(path => path.startsWith('/api/')), 'fixture does not use a real Host, VM or model')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ engine, fullGraph: true, keyboard: true, sharedWorkspaceStyles: true, disabledCloud: true, requests: requests.length, errors }))
} finally { await browser.close() }
