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
  async function fixture(native, lang = 'zh-CN') {
    const page = await browser.newPage({ viewport: { width: 900, height: 650 } })
    page.on('pageerror', error => errors.push(error.message))
    await page.setContent(`<html lang="${lang}"><body style="margin:0"><div id="root" style="width:440px;height:620px"></div><div data-shell-overlay="true"></div></body></html>`)
    for (const file of ['react/umd/react.development.js', 'react-dom/umd/react-dom.development.js']) await page.addScriptTag({ path: resolve(deps, 'node_modules', file) })
    await page.addScriptTag({ content: `
      window.calls=[];window.listeners=[];window.active=null;window.tabs=new Set();window.lease=null;
      window.origin='https://example.com';window.holdGrant=false;window.ttl=600000;window.corrupt=false;window.badGrantReply=false;
      const receipt=owner=>({origin,grant:lease?.owner===owner&&lease.expires>Date.now()?{owner,allowActions:lease.actions,remainingMs:lease.expires-Date.now()}:null});
      window.__TAURI__=${native ? ` {core:{invoke:async(command,args)=>{
        calls.push({command,args});
        if(command==='desktop_browser_activate'){if(active!==args.tabId)lease=null;active=args.tabId;return tabs.has(active)}
        if(command==='desktop_browser_navigate'){tabs.add(args.tabId);active=args.tabId;origin=new URL(args.url).origin}
        if(command==='desktop_browser_access')return corrupt?{origin,grant:{owner:'another-session',allowActions:true,remainingMs:600000}}:receipt(args.owner);
        if(command==='desktop_browser_delegate'){
          if(holdGrant){window.grantStarted=true;await new Promise(resolve=>window.releaseGrant=resolve);holdGrant=false;}
          if(args.owner&&args.expectedOrigin!==origin)throw Error('origin changed');
          lease=args.owner?{owner:args.owner,actions:args.allowActions,expires:Date.now()+ttl}:null;
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
  for (const lang of ['zh-CN', 'en']) {
    const page = await fixture(false, lang)
    const zh = lang.startsWith('zh')
    await page.getByRole('button', { name: zh ? /Agent 访问/ : /Agent access/ }).click()
    await page.getByRole('region', { name: zh ? '浏览器 Agent 访问' : 'Browser Agent access' }).getByText('https://example.com', { exact: true }).waitFor()
    await page.getByRole('radio', { name: zh ? /交互/ : /Interactive/ }).check()
    assert.ok(await page.getByRole('button', { name: zh ? '授予交互访问' : 'Grant interactive access' }).isDisabled())
    await page.getByText(zh ? /这是 Web 界面预览/ : /Web UI preview only/).waitFor()
    assert.equal(await page.evaluate(() => calls.length), 0)
    assert.equal(await page.locator('iframe').count(), 0)
    await page.close()
  }
  const page = await fixture(true)
  const trigger = page.getByRole('button', { name: /Agent 访问/ })
  await page.waitForFunction(() => active === 'browser:1')
  await trigger.click()
  await page.getByRole('button', { name: '授予只读访问' }).click()
  await page.getByRole('button', { name: /Agent 访问.*只读/ }).waitFor()
  assert.equal(await page.evaluate(() => lease.actions), false)
  const geometry = await page.evaluate(() => ({ panel: document.getElementById('xhbrowser-access-panel').getBoundingClientRect().bottom,
    native: calls.filter(x => x.command === 'desktop_browser_bounds').at(-1).args.bounds.y }))
  assert.ok(geometry.native >= geometry.panel, 'inline panel must push native page bounds down')
  await page.getByRole('radio', { name: /交互/ }).check()
  assert.equal(await page.evaluate(() => lease.actions), false, 'radio selection must not grant or escalate')
  await page.getByRole('button', { name: '授予交互访问' }).click()
  await page.getByRole('button', { name: /Agent 访问.*交互/ }).waitFor()
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await page.waitForFunction(() => lease === null)
  await page.getByRole('button', { name: /Agent 访问.*未授权/ }).waitFor()
  // A slow native grant is not cancelled by status polling or double dispatch.
  await page.evaluate(() => { holdGrant = true; grantStarted = false })
  await page.getByRole('button', { name: '授予交互访问' }).click()
  await page.waitForFunction(() => grantStarted)
  await page.waitForTimeout(2100)
  assert.equal(await page.evaluate(() => lease), null, 'no optimistic granted status')
  assert.ok(await page.getByRole('button', { name: '确认中…' }).isDisabled())
  await page.evaluate(() => releaseGrant())
  await page.getByRole('button', { name: /Agent 访问.*交互/ }).waitFor()
  // A missing receipt is not authorization; revoke any side effect on old IPC versions.
  await page.evaluate(() => { badGrantReply = true })
  await page.getByRole('button', { name: '授予交互访问' }).click()
  await page.getByRole('status').getByText(/授权状态不可用/).waitFor()
  assert.equal(await page.evaluate(() => lease), null)
  await page.evaluate(() => { badGrantReply = false })
  // Hiding under a download popover revokes; resize must not revive it.
  await page.getByRole('button', { name: '下载记录', exact: true }).click()
  await page.waitForFunction(() => active === null && lease === null)
  await page.setViewportSize({ width: 940, height: 670 })
  await page.getByRole('button', { name: '下载记录', exact: true }).click()
  await page.waitForFunction(() => active === 'browser:1')
  await page.getByRole('button', { name: /Agent 访问.*未授权/ }).waitFor()
  // Global modal visibility is a grant boundary, not only a geometry update.
  await page.evaluate(() => {
    const modal = document.createElement('div'); modal.role = 'dialog'; modal.textContent = 'fixture modal';
    document.querySelector('[data-shell-overlay]').append(modal)
  })
  await page.waitForFunction(() => active === null)
  await page.getByRole('button', { name: '授予交互访问' }).click()
  await page.getByRole('status').getByText(/网页不可见或正在切换/).waitFor()
  assert.equal(await page.evaluate(() => lease), null)
  await page.evaluate(() => document.querySelector('[role="dialog"]').remove())
  await page.waitForFunction(() => active === 'browser:1')
  // Same tab in another session must be deactivated and cannot inherit consent.
  await page.getByRole('button', { name: '授予交互访问' }).click()
  await page.getByRole('button', { name: /Agent 访问.*交互/ }).waitFor()
  await page.evaluate(() => setSession('session-child'))
  await page.getByRole('button', { name: /Agent 访问.*未授权/ }).waitFor()
  await page.waitForFunction(() => lease === null && active === 'browser:1')
  await trigger.click()
  await page.getByText('session-child', { exact: true }).waitFor()
  // Grant reply delayed across a session switch is revoked before other IPC work.
  await page.evaluate(() => { holdGrant = true; grantStarted = false })
  await page.getByRole('button', { name: '授予只读访问' }).click()
  await page.waitForFunction(() => grantStarted)
  await page.evaluate(() => setSession('session-next'))
  await page.evaluate(() => releaseGrant())
  try { await page.waitForFunction(() => lease === null && active === 'browser:1') } catch(e) { console.log(await page.evaluate(() => ({active,lease,calls:calls.slice(-24)}))); throw e }
  await page.getByRole('button', { name: /Agent 访问.*未授权/ }).waitFor()
  await trigger.click()
  // Native origin is authoritative even when the UI URL was not yet updated.
  await page.evaluate(() => { origin = 'https://redirect.example' })
  await page.getByRole('button', { name: '授予只读访问' }).click()
  await page.getByRole('status').getByText(/origin changed/).waitFor()
  assert.equal(await page.evaluate(() => lease), null)
  await page.evaluate(() => { origin = 'https://example.com'; ttl = 100 })
  await page.getByRole('button', { name: '授予只读访问' }).click()
  await page.getByRole('button', { name: /Agent 访问.*未授权/ }).waitFor()
  // Malformed/cross-session status cannot display a grant.
  await page.evaluate(() => { ttl = 600000; corrupt = true })
  try { await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('无效的原生授权状态')) } catch(e) { console.log(await page.evaluate(() => ({text:document.body.innerText,lease,calls:calls.slice(-15)}))); throw e }
  await page.getByRole('button', { name: /Agent 访问.*状态未确认/ }).waitFor()
  await page.evaluate(() => { corrupt = false; setSession(null) })
  await trigger.click()
  await page.getByText('未选择会话', { exact: true }).waitFor()
  assert.ok(await page.getByRole('button', { name: '授予只读访问' }).isDisabled())
  await page.evaluate(() => root.unmount())
  await page.waitForFunction(() => active === null)
  await page.close()
  assert.deepEqual(errors, [])
  console.log(`${engine}: Web honesty, bilingual access UI, native receipt/scope/expiry and async races passed (mock IPC)`)
} finally { await browser.close() }
