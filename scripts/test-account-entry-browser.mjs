/** Real assembled UI, fixture transport only; no sign-in or native permissions. */
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, sep, extname } from 'node:path'

const engine = process.env.UI_TEST_BROWSER ?? 'chromium'
assert.ok(['chromium', 'webkit'].includes(engine))
const require = createRequire(resolve(process.env.UI_TEST_DEPS ?? '/tmp/xharness-model-ui-tests', 'package.json'))
const browser = await require('playwright')[engine].launch({ headless: true })
const base = resolve('ui/dist')
const types = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.wasm': 'application/wasm' }
try {
  for (const lang of ['zh-CN', 'en-US']) for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ locale: lang, colorScheme: theme, viewport: { width: 1280, height: 820 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', route => {
      const url = new URL(route.request().url())
      const file = resolve(base, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)))
      if (url.hostname !== '127.0.0.1' || !file.startsWith(base + sep) || !existsSync(file)) return route.abort('blockedbyclient')
      return route.fulfill({ body: readFileSync(file), contentType: types[extname(file)] ?? 'application/octet-stream' })
    })
    await page.goto('http://127.0.0.1:39187/?fixture=1')
    const zh = lang.startsWith('zh')
    const trigger = page.getByRole('button', { name: zh ? '账号与设置' : 'Account & settings', exact: true })
    const account = page.getByRole('menuitem', { name: zh ? '账号与额度' : 'Account & allowance', exact: true })
    const settings = page.getByRole('menuitem', { name: zh ? '设置' : 'Settings', exact: true })
    const profile = page.getByRole('menuitem', { name: zh ? '使用档案' : 'Usage profile', exact: true })
    const dialog = page.getByRole('dialog', { name: zh ? '设置' : 'Settings', exact: true })
    await trigger.click()
    await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem')
    assert.equal(await account.evaluate(el => el === document.activeElement), true)
    await account.press('End')
    assert.equal(await settings.evaluate(el => el === document.activeElement), true)
    await settings.press('Home')
    assert.equal(await account.evaluate(el => el === document.activeElement), true)
    await account.press('Escape')
    assert.equal(await page.getByRole('menu').count(), 0)
    assert.equal(await trigger.evaluate(el => el === document.activeElement), true)

    for (const [target, section] of [[account, 'managed-account'], [profile, 'profile'], [settings, 'general']]) {
      await trigger.click()
      await target.click()
      await dialog.waitFor()
      assert.equal(await page.getByRole('menu').count(), 0)
      const selected = dialog.locator('button[aria-current="true"]')
      assert.equal(await selected.innerText(), section === 'managed-account' ? (zh ? '账户与模型服务' : 'Account & model service')
        : section === 'profile' ? (zh ? '使用档案' : 'Profile') : (zh ? '通用设置' : 'General'))
      if (section === 'managed-account') {
        await dialog.getByText(zh ? '请在桌面软件中连接账号。' : 'Connect your account in the desktop app.', { exact: true }).waitFor()
        assert.equal(await dialog.getByRole('button', { name: zh ? '连接账号' : 'Connect account', exact: true }).count(), 0)
      }
      await dialog.getByRole('button', { name: zh ? '关闭' : 'Close', exact: true }).click()
      assert.equal(await trigger.evaluate(el => el === document.activeElement), true, 'durable modal opener')
    }
    // Deterministic layout-only transition: no outside pointer event. The
    // delayed wide->rail commit must keep a newly opened menu and its focus,
    // and must re-anchor it to the settled trigger rather than stale geometry.
    await trigger.click()
    await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem')
    await page.getByRole('button', { name: zh ? '收起侧边栏' : 'Collapse sidebar', exact: true }).evaluate(el => el.click())
    await page.waitForFunction(() => document.querySelector('[data-xh-account-trigger]')?.classList.contains('xhAccount_rail'))
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true', 'layout settle does not dismiss live menu')
    assert.equal(await account.evaluate(el => el === document.activeElement), true, 'focus survives rail commit')
    const anchor = await trigger.boundingBox()
    const placed = await page.getByRole('menu').boundingBox()
    assert.ok(Math.abs(placed.y + placed.height + 4 - anchor.y) < 1, 'menu remeasures settled anchor')
    await settings.click(); await dialog.waitFor()
    await dialog.getByRole('button', { name: zh ? '关闭' : 'Close', exact: true }).click()
    await page.getByRole('button', { name: zh ? '打开侧边栏' : 'Open sidebar', exact: true }).click()

    // Collapse while a menu is visible, then validate the same entry in rail.
    await trigger.click()
    await page.getByRole('button', { name: zh ? '收起侧边栏' : 'Collapse sidebar', exact: true }).click()
    assert.equal(await page.getByRole('menu').count(), 0)
    await page.setViewportSize({ width: 426, height: 664 })
    await trigger.click()
    const box = await page.getByRole('menu').boundingBox()
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 426 && box.y + box.height <= 664, 'rail menu fits viewport')
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true')
    await account.press('Escape')
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false')
    assert.deepEqual(errors, [])
    await page.close()
  }
  console.log(`${engine}: account entry, bilingual themed menu, keyboard, focus restoration, Web limitation, feature routing and narrow rail passed`)
} finally { await browser.close() }
