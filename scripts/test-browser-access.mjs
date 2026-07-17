// Real React/DOM, mocked Tauri IPC. Not a native or model end-to-end score.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
const deps = resolve(process.env.UI_TEST_DEPS ?? '/tmp/xharness-model-ui-tests')
const require = createRequire(resolve(deps, 'package.json'))
const { chromium, webkit } = require('playwright')
const engine = process.env.UI_TEST_BROWSER ?? 'chromium'
const browser = await ({ chromium, webkit })[engine].launch({ headless: true })
try {
  const errors = []
  async function fixture(native, lang = 'zh-CN', controlledClock = false) {
    const page = await browser.newPage({ viewport: { width: 900, height: 650 } })
    page.on('pageerror', error => errors.push(error.message))
    if (controlledClock) await page.clock.install()
    await page.setContent(`<html lang="${lang}"><body style="margin:0"><div id="root" style="width:440px;height:620px"></div><div data-shell-overlay="true"></div></body></html>`)
    for (const file of ['react/umd/react.development.js', 'react-dom/umd/react-dom.development.js']) await page.addScriptTag({ path: resolve(deps, 'node_modules', file) })
    await page.addScriptTag({ content: `
      window.calls=[];window.listeners=[];window.active=null;window.tabs=new Set();window.lease=null;
      window.origin='https://example.com';window.holdGrant=false;window.badGrantReply=false;window.finishLoads=true;
      window.emit=(kind,value='')=>listeners.forEach(fn=>fn({payload:{tabId:'browser:1',kind,value}}));
      const receipt=owner=>({origin,grant:lease?.owner===owner&&lease.expires>Date.now()?{owner,allowActions:lease.actions,remainingMs:lease.expires-Date.now()}:null});
      window.__TAURI__=${native ? ` {core:{invoke:async(command,args)=>{
        calls.push({command,args});
        if(command==='desktop_browser_activate'){if(active!==args.tabId)lease=null;active=args.tabId;return tabs.has(active)}
        if(command==='desktop_browser_navigate'){
          tabs.add(args.tabId);active=args.tabId;origin=new URL(args.url).origin;
          if(finishLoads)setTimeout(()=>emit('loaded',args.url),0);
        }
        if(command==='desktop_browser_delegate'){
          if(holdGrant){window.grantStarted=true;await new Promise(resolve=>window.releaseGrant=resolve);holdGrant=false;}
          if(args.owner&&args.expectedOrigin!==origin){lease=null;throw Error('origin changed');}
          lease=args.owner?{owner:args.owner,actions:args.allowActions,expires:Date.now()+600000}:null;
          return badGrantReply ? null : receipt(args.owner);
        }
      }},event:{listen:async(_name,fn)=>{listeners.push(fn);return()=>{listeners=listeners.filter(x=>x!==fn)}}}}` : 'null'};
      window.__ModuleLoader__={load:x=>window.registration=x};
    ` })
    await page.addScriptTag({ content: readFileSync(new URL('../ui/dist/plugins/@xlang/xharness-client-ui-browser/client.js', import.meta.url), 'utf8') })
    await page.evaluate(() => {
      const plugin = registration.factory(id => id === 'react' ? React : {})
      plugin.apply({ effect: fn => fn(), slots: { inject: (_name, fn) => fn(), register: () => {} } })
      window.root = ReactDOM.createRoot(document.getElementById('root'))
      function App() {
        const [item, setItem] = React.useState({ id: 'browser:1', kind: 'browser', entries: ['https://example.com/'], position: 0, title: 'example.com' })
        const [sessionId, setSession] = React.useState('session-parent')
        const [open, setOpen] = React.useState(true)
        window.setSession = setSession; window.setItem = setItem; window.setOpen = setOpen
        return React.createElement(plugin.BrowserPane, { item, sessionId, open, onUpdate: patch => setItem(value => ({ ...value, ...patch })), onClose: () => setOpen(false), onNewBrowser: () => {} })
      }
      root.render(React.createElement(App))
    })
    return page
  }
  async function noAccessUI(page) {
    assert.equal(await page.getByRole('radiogroup').count(), 0)
    assert.equal(await page.getByRole('button', { name: /Agent 访问|Agent access|授予|Grant|撤销|Revoke/ }).count(), 0)
    assert.equal(await page.locator('[class*="xhbrowser-access-"]').count(), 0)
    assert.equal(await page.getByText('session-parent', { exact: true }).count(), 0)
  }
  for (const lang of ['zh-CN', 'en']) {
    const page = await fixture(false, lang)
    await page.getByRole('textbox', { name: '网址' }).waitFor()
    await noAccessUI(page)
    assert.equal(await page.evaluate(() => calls.length), 0, 'ordinary Web must not simulate native access')
    assert.equal(await page.locator('iframe').count(), 0)
    await page.getByText(/网页版不能嵌入/).waitFor()
    await page.close()
  }
  const page = await fixture(true)
  await page.waitForFunction(() => lease?.owner === 'session-parent')
  await noAccessUI(page)
  assert.equal(await page.evaluate(() => lease.actions), true, 'model may choose observe or perform; Host approval still applies')
  const grants = () => page.evaluate(() => calls.filter(x => x.command === 'desktop_browser_delegate').length)
  const firstCount = await grants()
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await page.setViewportSize({ width: 940, height: 670 })
  await page.waitForTimeout(2100)
  assert.equal(await grants(), firstCount, 'no status polling or repeated grants on ordinary layout work')
  assert.equal(await page.evaluate(() => calls.some(x => x.command === 'desktop_browser_access')), false)
  assert.equal(await page.evaluate(() => calls.some(x => /inspect|perform/.test(x.command))), false, 'binding itself must not execute a model action')

  // Hidden native pages cannot cover local/global overlays or remain agent-accessible.
  await page.getByRole('button', { name: '下载记录', exact: true }).click()
  await page.waitForFunction(() => active === null && lease === null)
  const hiddenCount = await grants()
  await page.setViewportSize({ width: 960, height: 680 })
  await page.waitForTimeout(100)
  assert.equal(await grants(), hiddenCount)
  await page.getByRole('button', { name: '下载记录', exact: true }).click()
  await page.waitForFunction(() => active === 'browser:1' && lease?.owner === 'session-parent')
  await page.evaluate(() => {
    const modal = document.createElement('div'); modal.role = 'dialog'; modal.textContent = 'fixture modal';
    document.querySelector('[data-shell-overlay]').append(modal)
  })
  await page.waitForFunction(() => active === null && lease === null)
  await page.evaluate(() => document.querySelector('[role="dialog"]').remove())
  await page.waitForFunction(() => lease?.owner === 'session-parent')

  // The same visible tab is rebound to the actual selected chat, not inherited.
  const switchStart = await page.evaluate(() => calls.length)
  await page.evaluate(() => setSession('session-child'))
  await page.waitForFunction(() => lease?.owner === 'session-child')
  const switched = await page.evaluate(start => calls.slice(start), switchStart)
  assert.ok(switched.some(x => x.command === 'desktop_browser_activate' && x.args.tabId === null))
  assert.ok(switched.some(x => x.command === 'desktop_browser_delegate' && x.args.owner === 'session-child'))

  // A slow old binding is undone before the next chat gets access.
  await page.evaluate(() => { holdGrant = true; grantStarted = false; setSession('session-delayed') })
  await page.waitForFunction(() => grantStarted)
  await page.evaluate(() => setSession('session-next'))
  const delayedStart = await page.evaluate(() => calls.length)
  await page.evaluate(() => releaseGrant())
  await page.waitForFunction(() => lease?.owner === 'session-next')
  const delayed = await page.evaluate(start => calls.slice(start), delayedStart)
  const revoke = delayed.findIndex(x => x.command === 'desktop_browser_activate' && x.args.tabId === null)
  const next = delayed.findIndex(x => x.command === 'desktop_browser_delegate' && x.args.owner === 'session-next')
  assert.ok(revoke >= 0 && next > revoke)

  // Closing or covering the pane during a pending binding must undo its reply.
  for (const boundary of ['popover', 'close']) {
    await page.evaluate(boundary => { holdGrant = true; grantStarted = false; setSession(`session-${boundary}`) }, boundary)
    await page.waitForFunction(() => grantStarted)
    if (boundary === 'popover') await page.getByRole('button', { name: '下载记录', exact: true }).click()
    else await page.evaluate(() => setOpen(false))
    await page.evaluate(() => releaseGrant())
    await page.waitForFunction(() => active === null && lease === null)
    if (boundary === 'popover') await page.getByRole('button', { name: '下载记录', exact: true }).click()
    else await page.evaluate(() => setOpen(true))
    await page.waitForFunction(boundary => active === 'browser:1' && lease?.owner === `session-${boundary}`, boundary)
  }

  // Uncertain IPC replies cannot leave an optimistic native grant behind.
  await page.evaluate(() => { badGrantReply = true; setSession('session-bad') })
  await page.getByRole('alert').getByText(/浏览器会话绑定失败/).waitFor()
  assert.equal(await page.evaluate(() => lease), null)
  assert.equal(await page.evaluate(() => active), null)
  await page.evaluate(() => { badGrantReply = false; setSession('session-recovered') })
  await page.waitForFunction(() => lease?.owner === 'session-recovered')

  // Navigation awaits native load completion; a stale UI origin is not binding authority.
  await page.evaluate(() => { finishLoads = false })
  const address = page.getByRole('textbox', { name: '网址' })
  await address.fill('https://other.example.com/'); await address.press('Enter')
  await page.waitForFunction(() => origin === 'https://other.example.com')
  const navigatingCount = await grants()
  await page.waitForTimeout(100)
  assert.equal(await grants(), navigatingCount)
  await page.evaluate(() => emit('loaded', 'https://other.example.com/'))
  await page.waitForFunction(() => lease?.owner === 'session-recovered' && calls.filter(x => x.command === 'desktop_browser_delegate').at(-1).args.expectedOrigin === 'https://other.example.com')
  await page.evaluate(() => { origin = 'https://redirect.example'; lease = null; setSession('session-redirect') })
  await page.getByRole('alert').getByText(/origin changed/).waitFor()
  assert.equal(await page.evaluate(() => lease), null)
  await page.evaluate(() => { emit('url', 'https://redirect.example/'); emit('loaded', 'https://redirect.example/') })
  await page.waitForFunction(() => lease?.owner === 'session-redirect' && active === 'browser:1')
  await page.evaluate(() => setSession(null))
  await page.waitForFunction(() => lease === null && active === 'browser:1')
  const anonymousCount = await grants()
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await page.waitForTimeout(100)
  assert.equal(await grants(), anonymousCount, 'no model owner in global/anonymous workspace')
  await page.evaluate(() => root.unmount())
  await page.waitForFunction(() => active === null)
  await page.close()

  // No manual renewal: the visible context stays usable without 2-second polling.
  const renewal = await fixture(true, 'zh-CN', true)
  await renewal.waitForFunction(() => lease?.owner === 'session-parent')
  const initial = await renewal.evaluate(() => calls.filter(x => x.command === 'desktop_browser_delegate').length)
  await renewal.clock.fastForward(300100)
  await renewal.waitForFunction(initial => calls.filter(x => x.command === 'desktop_browser_delegate').length === initial + 1, initial)
  await renewal.getByRole('button', { name: '下载记录', exact: true }).click()
  await renewal.waitForFunction(() => lease === null && active === null)
  const stopped = await renewal.evaluate(() => calls.filter(x => x.command === 'desktop_browser_delegate').length)
  await renewal.clock.fastForward(600100)
  assert.equal(await renewal.evaluate(() => calls.filter(x => x.command === 'desktop_browser_delegate').length), stopped)
  await renewal.evaluate(() => root.unmount())
  await renewal.close()
  assert.deepEqual(errors, [])
  console.log(`${engine}: no manual access UI; automatic visible-chat binding, no polling, renewal, overlays, navigation and async races passed (mock IPC)`)
} finally { await browser.close() }
