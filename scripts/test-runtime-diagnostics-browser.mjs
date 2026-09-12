import assert from 'node:assert/strict'
import { readFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
const require = createRequire(resolve(process.env.UI_TEST_DEPS ?? '.', 'package.json'))
const { chromium } = require('playwright')
const browser = await chromium.launch({ headless: true, ...(process.env.UI_TEST_EXECUTABLE ? { executablePath: process.env.UI_TEST_EXECUTABLE } : {}) })
try {
  const page = await browser.newPage({ viewport: { width: 660, height: 840 } })
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.route('https://diagnostics.test/**', route => {
    const js = route.request().url().endsWith('.js')
    route.fulfill({ contentType: js ? 'text/javascript' : 'text/html', body: readFileSync(new URL('../apps/desktop/frontend/diagnostics.' + (js ? 'js' : 'html'), import.meta.url)) })
  })
  await page.addInitScript(() => {
    let deep = false, persistent = false, fullMemory = false
    window.__TAURI__ = { core: { invoke: async (name, args) => {
      if (name === 'desktop_diagnostics_status') return { available: true, hostRunning: false, previousAbnormalExit: true, deepActive: deep, deepPersistent: persistent, fullMemory, deepRemainingSeconds: deep && !persistent ? 900 : 0, version: '0.2.x', platform: 'windows' }
      if (name === 'desktop_set_deep_diagnostics') { deep = args.enabled; persistent = deep && args.persistent; fullMemory = deep && args.fullMemory }
      if (name === 'desktop_export_diagnostics') return 'D:\\XHarness\\diagnostics\\export.json'
    } } }
  })
  await page.goto('https://diagnostics.test/')
  await page.getByText('后台未运行', { exact: false }).waitFor()
  await page.getByRole('button', { name: '导出本机诊断包' }).click()
  await page.getByText('诊断包已保存到：', { exact: false }).waitFor()
  await page.locator('#consent').check()
  await page.getByRole('button', { name: '开启 15 分钟' }).click()
  await page.getByText('已开启 · 剩余 15 分钟').waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.setViewportSize({ width: 500, height: 640 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.getByRole('button', { name: '立即关闭' }).click()
  await page.locator('#persistent').check()
  await page.locator('#full-memory').check()
  await page.getByRole('button', { name: '持续开启', exact: true }).click()
  await page.getByText('持续开启 · 重启后保留，直到手动关闭。', { exact: true }).waitFor()
  assert.equal(await page.locator('#full-memory').isChecked(), true)
  assert.equal(await page.locator('#disable').isEnabled(), true)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  assert.deepEqual(errors, [])
  mkdirSync('dist/diagnostics-evidence', { recursive: true })
  await page.setViewportSize({ width: 660, height: 840 })
  await page.screenshot({ path: 'dist/diagnostics-evidence/diagnostics.png', fullPage: true })
  await page.getByRole('button', { name: '立即关闭' }).click()
  console.log('Diagnostics browser layout, keyboard-accessible inputs and actions passed')
} finally { await browser.close() }
