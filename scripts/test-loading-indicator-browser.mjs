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
  await page.addInitScript(() => {
    const start = window.setInterval, stop = window.clearInterval
    window.previewIntervals = new Set()
    window.setInterval = (fn, delay, ...args) => {
      const id = start(fn, delay, ...args); previewIntervals.add(id); return id
    }
    window.clearInterval = id => { previewIntervals.delete(id); stop(id) }
  })
  await page.goto(process.env.UI_TEST_URL ?? `http://127.0.0.1:${server.address().port}/`)
  const ring = page.locator('[data-xh-loading-ring]')
  const timer = page.getByRole('timer')
  const elapsed = async () => Number(await timer.getAttribute('data-elapsed-ms'))
  await ring.waitFor()
  assert.equal(await ring.count(), 1)
  const styles = await ring.evaluate(element => ({
    size: [element.getBoundingClientRect().width, element.getBoundingClientRect().height],
    viewBox: element.getAttribute('viewBox'),
    pixels: element.querySelectorAll('rect').length,
    circles: element.querySelectorAll('circle').length,
    motion: getComputedStyle(element.querySelector('rect')).animationName,
    duration: getComputedStyle(element.querySelector('rect')).animationDuration,
    easing: getComputedStyle(element.querySelector('rect')).animationTimingFunction,
    entrance: getComputedStyle(element.parentElement).animationDuration,
    svgAnimation: getComputedStyle(element).animationName,
    visibleText: element.parentElement.textContent,
  }))
  assert.deepEqual(styles, { size: [16,16], viewBox:'0 0 16 16', pixels:12, circles:0,
    motion:'xhLoading_chase', duration:'1.2s', easing:'linear', entrance:'0.9s', svgAnimation:'none', visibleText:'' })
  report.checks.push('16px monochrome ring, twelve 2px pixels, 1.2s opacity chase, 900ms entrance, no visible status copy')
  await page.evaluate(() => {
    window.previousRing = document.querySelector('[data-xh-loading-ring]')
    window.previousPixel = previousRing.querySelector('rect')
    window.previousAnimation = previousPixel.getAnimations()[0]
    window.previousTime = previousAnimation.currentTime
  })
  assert.equal(await page.evaluate(() => previewIntervals.size), 1, 'one leaf clock owns one interval')
  const before = await elapsed()
  await page.waitForFunction(start => Number(document.querySelector('[role="timer"]').dataset.elapsedMs) >= start + 1000, before)
  assert.match(await timer.textContent(), /^(?:\d+h \d{2}m |\d+m )?\d+s$/)
  assert.doesNotMatch(await timer.textContent(), /运行|用时|总耗时|秒/)
  assert.equal(await timer.getAttribute('aria-live'), 'off')
  await page.getByRole('button', { name: '切换预览配色' }).click()
  assert.equal(await page.evaluate(() => document.querySelector('[data-xh-loading-ring]') === previousRing && previousPixel.getAnimations()[0] === previousAnimation && previousAnimation.currentTime > previousTime), true)
  assert.ok(await elapsed() >= before, 'theme changes cannot reset elapsed time')
  report.checks.push('clock ticks without remounting ring or restarting pixel animation; theme changes retain run anchor')
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-xh-loading-indicator]')).opacity === '1')
  await page.screenshot({ path: resolve(evidence, engine + '-light.png'), fullPage: true })
  await page.getByRole('button', { name: '切换预览配色' }).click()
  await page.screenshot({ path: resolve(evidence, engine + '-dark.png'), fullPage: true })
  await page.getByRole('button', { name: '重播淡入' }).click()
  assert.equal(await page.evaluate(() => previousRing.isConnected), false)
  assert.ok(await elapsed() >= before, 'replay does not reset run time')
  report.checks.push('explicit replay restarts entrance, not the elapsed anchor')
  const beforeTool = await elapsed()
  await page.getByRole('button', { name: '准备工具', exact: true }).click()
  assert.equal(await ring.count(), 1)
  assert.ok(await elapsed() >= beforeTool, 'tool phase retains the same run anchor')
  await page.locator('summary').click()
  assert.match(await page.locator('pre').textContent(), /cat package.json/)
  await page.getByRole('button', { name: '等待确认', exact: true }).click()
  assert.equal(await ring.count(), 0)
  const beforeApproval = await elapsed()
  await page.waitForFunction(start => Number(document.querySelector('[role="timer"]').dataset.elapsedMs) >= start + 1000, beforeApproval)
  await page.getByRole('button', { name: '允许一次', exact: true }).click()
  assert.equal(await ring.count(), 1)
  await page.getByRole('button', { name: '完成', exact: true }).click()
  assert.equal(await ring.count(), 0)
  assert.equal(await page.evaluate(() => previewIntervals.size), 0, 'completion cleans up the clock interval')
  const finished = await elapsed()
  await page.waitForTimeout(1100)
  assert.equal(await elapsed(), finished, 'completion freezes elapsed time')
  await page.getByRole('button', { name: '等待回复', exact: true }).click()
  assert.ok(await elapsed() < finished, 'a new run gets a fresh anchor')
  assert.equal(await page.evaluate(() => previewIntervals.size), 1, 'phase switches and replay never leak timers')
  report.checks.push('tool and approval preserve clock; approval/done remove ring; completion freezes; next run resets')
  await page.setViewportSize({ width: 360, height: 760 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-xh-loading-indicator]')).opacity === '1')
  await page.screenshot({ path: resolve(evidence, engine + '-mobile.png'), fullPage: true })
  report.checks.push('360px layout has no horizontal overflow')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  assert.deepEqual(await ring.evaluate(svg => [getComputedStyle(svg.parentElement).animationName,
    ...[...svg.querySelectorAll('rect')].map(e => getComputedStyle(e).animationName)]), Array(13).fill('none'))
  assert.equal(await ring.evaluate(svg => getComputedStyle(svg.querySelector('rect')).opacity), '0.65')
  report.checks.push('reduced motion disables entrance and every pixel animation, leaving a visible static ring')
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
