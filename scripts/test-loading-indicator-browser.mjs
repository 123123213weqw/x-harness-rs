import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { startLoadingPreview } from './preview-loading-indicator.mjs'
const require = createRequire(resolve(process.env.UI_TEST_DEPS ?? '/tmp/ui-tests', 'package.json'))
const engine = process.env.UI_TEST_BROWSER ?? 'chromium'
assert.ok(['chromium', 'webkit'].includes(engine))
const evidence = resolve(process.env.UI_TEST_EVIDENCE ?? 'dist/loading-indicator-evidence')
mkdirSync(evidence, { recursive: true })
const output = mkdtempSync(resolve(tmpdir(), 'xharness-loading-preview-'))
let browser, server
const report = { engine, checks: [], consoleErrors: [], unexpectedRequests: [] }
try {
  server = process.env.UI_TEST_URL ? undefined : await startLoadingPreview({ output, port: 0 })
  browser = await require('playwright')[engine].launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1000, height: 720 }, colorScheme: 'dark' })
  const page = await context.newPage()
  page.on('pageerror', error => report.consoleErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.hostname !== '127.0.0.1' || url.pathname.startsWith('/api/')) report.unexpectedRequests.push(request.url())
  })
  await page.goto(process.env.UI_TEST_URL ?? `http://127.0.0.1:${server.address().port}/`)
  const rotor = page.locator('[data-xh-loading-rotor]')
  await rotor.waitFor()
  assert.equal(await rotor.count(), 1)
  const styles = await rotor.evaluate(element => ({
    // The transformed bounding box changes while rotating; check layout dimensions.
    size: [element.offsetWidth, element.offsetHeight],
    rotation: getComputedStyle(element).animationDuration,
    easing: getComputedStyle(element).animationTimingFunction,
    entrance: getComputedStyle(element.parentElement).animationDuration,
    svgAnimation: getComputedStyle(element.firstElementChild).animationName,
    visibleText: element.parentElement.textContent,
  }))
  assert.deepEqual(styles, { size: [16, 16], rotation: '1s', easing: 'linear', entrance: '0.9s', svgAnimation: 'none', visibleText: '' })
  report.checks.push('16px, 1s linear outer rotation, 900ms entrance, no visible status text')
  await page.evaluate(() => {
    window.previousRotor = document.querySelector('[data-xh-loading-rotor]')
    window.previousAnimation = window.previousRotor.getAnimations()[0]
  })
  await page.getByRole('button', { name: '切换预览配色' }).click()
  assert.equal(await page.evaluate(() => document.querySelector('[data-xh-loading-rotor]') === window.previousRotor && window.previousRotor.getAnimations()[0] === window.previousAnimation), true)
  report.checks.push('theme rerender preserves rotor DOM and animation identity')
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-xh-loading-indicator]')).opacity === '1')
  await page.screenshot({ path: resolve(evidence, engine + '-light.png'), fullPage: true })
  await page.getByRole('button', { name: '切换预览配色' }).click()
  await page.screenshot({ path: resolve(evidence, engine + '-dark.png'), fullPage: true })
  await page.getByRole('button', { name: '重播淡入' }).click()
  assert.equal(await page.evaluate(() => window.previousRotor.isConnected), false)
  report.checks.push('explicit replay restarts the entrance')
  await page.getByRole('button', { name: '准备工具', exact: true }).click()
  assert.equal(await rotor.count(), 1)
  await page.locator('summary').click()
  assert.match(await page.locator('pre').textContent(), /cat package.json/)
  await page.getByRole('button', { name: '等待确认', exact: true }).click()
  assert.equal(await rotor.count(), 0)
  await page.getByRole('button', { name: '允许一次', exact: true }).click()
  assert.equal(await rotor.count(), 1)
  await page.getByRole('button', { name: '完成', exact: true }).click()
  assert.equal(await rotor.count(), 0)
  report.checks.push('waiting/tool spin; approval/completed do not; local controls work')
  await page.getByRole('button', { name: '等待回复', exact: true }).click()
  await page.setViewportSize({ width: 360, height: 760 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-xh-loading-indicator]')).opacity === '1')
  await page.screenshot({ path: resolve(evidence, engine + '-mobile.png'), fullPage: true })
  report.checks.push('360px layout has no horizontal overflow')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const reduced = await rotor.evaluate(element => [getComputedStyle(element).animationName, getComputedStyle(element.parentElement).animationName])
  assert.deepEqual(reduced, ['none', 'none'])
  report.checks.push('reduced motion disables entrance and rotor')
  assert.deepEqual(report.consoleErrors, [])
  assert.deepEqual(report.unexpectedRequests, [])
  report.passed = true
  writeFileSync(resolve(evidence, engine + '.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally {
  await browser?.close()
  if (server) await new Promise((done, reject) => server.close(error => error ? reject(error) : done()))
  rmSync(output, { recursive: true, force: true })
}
