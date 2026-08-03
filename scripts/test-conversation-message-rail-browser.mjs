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
  const assertLeft = async () => {
    const position = await rail.evaluate(el => {
      const box = el.getBoundingClientRect(), parent = el.parentElement.getBoundingClientRect()
      return { offset: box.left - parent.left, rightGap: parent.right - box.right }
    })
    assert.ok(Math.abs(position.offset - 8) <= 1, 'rail is at the approved left edge: ' + JSON.stringify(position))
    assert.ok(position.rightGap > position.offset, 'right-edge placement must not pass navigation-only tests')
  }
  await assertLeft()
  const marks = rail.getByRole('button')
  // Navigation is visible as soon as history data lands, before open/layout
  // finishes. Wait for the real initial tail-follow, not a fixed sleep.
  await page.getByText('Loading history…', { exact: true }).waitFor({ state: 'hidden' })
  await page.locator('[data-conversation-scroll]').evaluate(el => new Promise((resolve, reject) => {
    const start = performance.now()
    let previous, stableSince = start
    const sample = now => {
      const current = `${el.scrollTop}:${el.scrollHeight}:${el.clientHeight}`
      if (current !== previous) stableSince = now
      previous = current
      const gap = el.scrollHeight - el.clientHeight - el.scrollTop
      if (gap <= 1 && now - stableSince >= 120) return resolve()
      if (now - start > 5000) return reject(new Error('History never settles at its initial tail: ' + current))
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  }))
  const initialCount = await marks.count()
  assert.ok(initialCount >= 3, 'one rail mark per loaded user message')
  // A real reader first scrolls away from live bottom-follow. Programmatic
  // actionability scrolling alone does not establish that user intent in WebKit.
  await page.locator('[data-conversation-scroll]').hover()
  await page.locator('[data-conversation-scroll]').evaluate(el => {
    window.pagingTrace = []
    const record = event => {
      const first = window.firstWheelGeometry
      if (first && event.type === 'scroll') {
        const floor = Math.max(0, el.scrollHeight - el.clientHeight)
        if (el.scrollTop < Math.min(first.observed, floor) - 0.5) first.readUp = true
        first.observed = el.scrollTop
      }
      window.pagingTrace.push({ event: event.type, top: el.scrollTop, height: el.scrollHeight,
        viewport: el.clientHeight, delta: event.deltaY, target: event.target?.tagName, marks: document.querySelectorAll('.xh-message-rail-item').length,
        busy: [...document.querySelectorAll('button')].filter(button => /Load earlier|Loading/.test(button.textContent)).map(button => ({ text: button.textContent, disabled: button.disabled })) })
      if (window.pagingTrace.length > 80) window.pagingTrace.shift()
    }
    el.addEventListener('wheel', record, { passive: true }); el.addEventListener('scroll', record, { passive: true })
  })
  // The FIRST ordinary native gesture must work while the initial row
  // measurements may still be settling. Repeating input until one is accepted
  // would hide a cold-open race; a layout shrink at the floor is not movement.
  const firstBox = await page.locator('[data-conversation-scroll]').boundingBox()
  assert.ok(firstBox)
  await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + 64)
  await page.locator('[data-conversation-scroll]').evaluate(el => {
    window.firstWheelGeometry = { observed: el.scrollTop, readUp: false }
  })
  await page.mouse.wheel(0, -180)
  try {
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-conversation-scroll]')
      return window.firstWheelGeometry.readUp && el.scrollHeight - el.clientHeight - el.scrollTop >= 60
    }, null, { timeout: 3000 })
  } catch (error) {
    console.error(engine + ': first ordinary upward wheel was lost', await page.evaluate(() => window.pagingTrace))
    throw error
  }
  // Then use ordinary viewport-sized native gestures to reach the head.
  // No scrollTop writes or Load-earlier click: pagination must still be
  // triggered by genuine reader input through the shipped ChatView.
  try {
    const started = Date.now()
    let upwardDistance = 0
    for (let gesture = 0; gesture < 80 && await marks.count() === initialCount; gesture++) {
      assert.ok(Date.now() - started < 25_000, 'native upward paging must finish within the bounded gesture budget')
      const box = await page.locator('[data-conversation-scroll]').boundingBox()
      assert.ok(box)
      await page.mouse.move(box.x + box.width / 2, box.y + 64)
      const before = await page.locator('[data-conversation-scroll]').evaluate(el => el.scrollTop)
      await page.mouse.wheel(0, -Math.min(600, box.height * 0.8))
      const after = await page.locator('[data-conversation-scroll]').evaluate(el => new Promise((resolve, reject) => {
        const start = performance.now()
        let previous, stableSince = start
        const sample = now => {
          const current = `${el.scrollTop}:${el.scrollHeight}:${el.clientHeight}`
          if (current !== previous) stableSince = now
          previous = current
          if (now - stableSince >= 120) return resolve(el.scrollTop)
          if (now - start > 3000) return reject(new Error('Native paging gesture did not settle: ' + current))
          requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      }))
      upwardDistance += Math.max(0, before - after)
    }
    assert.ok(upwardDistance > 0, 'fixture must deliver real upward native scrolling')
    await page.waitForFunction(count => document.querySelectorAll('.xh-message-rail-item').length > count, initialCount)
  }
  catch (error) {
    console.error(engine + ': automatic pagination trace', await page.evaluate(() => window.pagingTrace), errors)
    throw error
  }
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
  // Exercise the real shell/workspace controls. Both docked and narrow drawer
  // modes hide navigation; closing only one of two tabs cannot re-show it.
  const loadedCount = await marks.count()
  for (const viewport of [{ width: 1500, height: 820, drawer: false }, { width: 850, height: 660, drawer: true }]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await rail.waitFor({ state: 'visible' })
    await assertLeft()
    await page.getByRole('button', { name: '展开右侧工作区', exact: true }).click()
    await rail.waitFor({ state: 'hidden' })
    await page.waitForFunction(drawer => document.querySelector('[data-xhworkspace-open]')?.hasAttribute('data-xhworkspace-drawer') === drawer, viewport.drawer)
    await page.getByRole('button', { name: '新建浏览器标签', exact: true }).click()
    const close = page.getByRole('button', { name: '关闭 新标签页', exact: true })
    assert.equal(await close.count(), 2)
    await close.last().click()
    assert.equal(await rail.isVisible(), false, 'another workspace tab keeps navigation hidden')
    assert.equal(await page.locator('.xh-message-rail-item').count(), loadedCount, 'hiding navigation never changes loaded history')
    await close.click()
    await rail.waitFor({ state: 'visible' })
    await assertLeft()
    assert.equal(await marks.count(), loadedCount)
    await first.click()
    assert.equal(await first.getAttribute('aria-current'), 'location', 'restored navigation remains usable')
  }
  assert.deepEqual(errors, [])
  console.log(engine + ': PASS: upward input auto-pages history; message rail stays at the left edge of current chat, navigates windowed messages and hides/restores with docked/drawer workspace')
} finally { await browser.close() }
