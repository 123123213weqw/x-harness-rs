// Actual shipped layout + sticky composer CSS and the desktop bridge; no user data.
import { verifyArtifact, shippedUnitValue } from './fixtures/shipped-source-values.mjs'
import assert from 'node:assert/strict'
import { scriptAsset } from './fixtures/script-asset-test.mjs'
import { readFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(resolve(process.env.UI_TEST_DEPS ?? repo, 'package.json'))
const { chromium, webkit } = require('playwright')
const engine = process.env.UI_TEST_BROWSER ?? 'chromium'
assert.ok(['chromium', 'webkit'].includes(engine))
const layout = verifyArtifact('@xharness/dsh-client-ui-layout')
const css = shippedUnitValue(layout, 'src/modules/layout/AppFrame.css')
const layoutClasses = shippedUnitValue(layout, 'src/modules/layout/AppFrame.styles.js')
const conversation = verifyArtifact('@xharness/dsh-client-ui-conversation')
const composerCss = shippedUnitValue(conversation, 'src/modules/conversation/skeleton/ConversationRoot.css')
const composerClasses = shippedUnitValue(conversation, 'src/modules/conversation/skeleton/ConversationRoot.styles.js')
const sidebarArtifact = verifyArtifact('@xharness/dsh-client-ui-sidebar')
const sidebarCss = shippedUnitValue(sidebarArtifact, 'src/modules/sidebar/SidebarRoot.css')
const sidebarClasses = shippedUnitValue(sidebarArtifact, 'src/modules/sidebar/SidebarRoot.styles.js')
const tasksCss = readFileSync(join(repo, 'ui/src/modules/tasks/Tasks.css'), 'utf8')
assert.match(readFileSync(join(repo, 'ui/src/modules/sidebar/SidebarRoot.tsx'), 'utf8'),
  /<div id="xharness-sidebar-updater-slot" hidden \/>/,
  'Production sidebar must provide the same initially empty reserved row as this fixture')
assert.ok(css.includes('overlayLayer') && composerCss.includes('position:sticky'), 'Real shell and composer layers required')
// Baseline override lets the regression demonstrate failure against an installed old bridge.
const source = process.env.UI_TEST_UPDATER_SOURCE
  ? readFileSync(process.env.UI_TEST_UPDATER_SOURCE, 'utf8')
  : scriptAsset('desktop-updater.js')
const output = process.env.UI_TEST_OUTPUT
if (output) mkdirSync(output, { recursive: true })
const browser = await ({ chromium, webkit }[engine]).launch({
  headless: true,
  ...(process.env.UI_TEST_EXECUTABLE ? { executablePath: process.env.UI_TEST_EXECUTABLE } : {}),
})
try {
  const page = await browser.newPage()
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  let cases = 0
  for (const { width, height } of [{ width: 1254, height: 768 }, { width: 600, height: 768 }, { width: 360, height: 480 }]) {
    for (const sidebar of [56, 260]) {
      await page.setViewportSize({ width, height })
      await page.setContent(`<style>
        html,body{height:100%;margin:0;font:15px system-ui;background:#f6f7f8}
        :root{--dsw-alias-bg-base:#f6f7f8;--dsw-specific-sidebar-fill:#e8eaed}
        ${css} ${composerCss} ${sidebarCss} ${tasksCss}
        .${layoutClasses.sidebarCol}{position:relative}
        #settings{height:40px}
        .${composerClasses.viewArea}{min-height:1200px!important;padding:24px}
        .${composerClasses.composerSeat}{min-height:200px;padding:40px 16px 16px;box-sizing:border-box}
        textarea{width:100%;height:120px;box-sizing:border-box}
        #chat-overlay{display:none}
        #shell-scrim{position:absolute;inset:0;background:#ffffffee}
      </style>
      <div class="${layoutClasses.frame}" style="grid-template-columns:${sidebar}px 1fr">
        <aside class="${layoutClasses.sidebarCol}">
          <div class="${sidebarClasses.root} ${sidebar === 56 ? sidebarClasses.collapsed : ''}">
            <div class="${sidebarClasses.regionArea}"></div>
            <div class="${sidebarClasses.footArea}">
              <div id="xharness-sidebar-updater-slot" hidden></div>
              <div class="${sidebarClasses.footerActions}"><button id="tasks" class="xhtask-trigger">Tasks</button></div>
              <div class="${sidebarClasses.settingsArea}"><button id="settings">设置</button></div>
            </div>
          </div>
        </aside>
        <main class="${layoutClasses.centerCol}">
          <div class="${composerClasses.root}" data-phase="active">
            <div class="${composerClasses.scrollBody}">
              <section class="${composerClasses.viewArea}"><h1>Chat</h1><p>Conversation remains the primary interface.</p></section>
              <footer class="${composerClasses.composerSeat}"><textarea aria-label="Message the agent"></textarea></footer>
            </div>
          </div>
        </main>
        <div id="chat-overlay" class="${layoutClasses.overlayLayer}"><div id="shell-scrim" role="dialog" aria-label="Chat settings / approval"></div></div>
      </div>`)
      await page.evaluate(() => {
        window.calls = []
        window.remote = { seq: 1, phase: 'available', version: '9.9.9' }
        window.escapeLeaked = false
        window.overlayClicks = 0
        document.addEventListener('keydown', event => { if (event.key === 'Escape') escapeLeaked = true })
        document.querySelector('#shell-scrim').addEventListener('click', () => overlayClicks++)
        window.__TAURI__ = {
          core: { invoke: async command => {
            calls.push(command)
            return command === 'desktop_status' ? { updaterConfigured: true } : remote
          } },
          event: { listen: async (_event, callback) => { window.emitUpdate = callback; return () => {} } },
        }
      })
      await page.addScriptTag({ content: source })
      const host = page.locator('#xharness-desktop-updater')
      await host.waitFor({ state: 'visible' })
      const toggle = host.locator('.toggle'), panel = host.locator('.panel')
      const assertReachable = async (locator, message) => {
        await locator.scrollIntoViewIfNeeded()
        const box = await locator.boundingBox()
        assert.ok(box?.width > 0 && box?.height > 0, message)
        const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
        assert.equal(await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.id, point), 'xharness-desktop-updater', message)
        return point
      }
      let seq = 1, fixtureClicks = 0
      for (const phase of ['available', 'downloaded', 'downloading', 'error']) {
        await page.evaluate(({ seq, phase }) => {
          remote = { seq, phase, version: '9.9.9', downloaded: 51, total: 100,
            ...(phase === 'error' ? { retryAction: 'download', message: 'offline' } : {}) }
          emitUpdate({ payload: remote })
        }, { seq: ++seq, phase })
        await assertReachable(toggle, 'Collapsed updater icon remains reachable')
        const updateBox = await toggle.boundingBox(), taskBox = await page.locator('#tasks').boundingBox()
        assert.ok(updateBox.y + updateBox.height <= taskBox.y, 'Reserved row keeps updater above Tasks with no overlapping hit targets')
        const taskPoint = {x: taskBox.x + taskBox.width / 2, y: taskBox.y + taskBox.height / 2}
        assert.equal(await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.id, taskPoint), 'tasks', 'Tasks is not covered by updater')
        await page.locator('#tasks').click()
        await toggle.click()
        await panel.waitFor({ state: 'visible' })
        // Check actual buttons, not just the panel centre: the gradient covers its bottom.
        for (const name of ['.close', '.action', '.diagnostics']) {
          await assertReachable(host.locator(name), `${engine} ${width} sidebar=${sidebar} ${phase}: ${name} must win over sticky composer`)
        }
        assert.equal(await panel.getAttribute('role'), 'dialog', 'Shadow panel exposes dialog semantics')
        assert.equal(await panel.getAttribute('aria-modal'), 'false', 'Updater is nonmodal and must not lock the conversation')
        const point = await assertReachable(host.locator('.diagnostics'), 'Bottom action reachable before opening shared overlay')
        if (output && phase === 'available' && sidebar === 56) await page.screenshot({ path: join(output, `${engine}-${width}-updater.png`) })
        await page.locator('#chat-overlay').evaluate(node => { node.style.display = 'block' })
        assert.equal(await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.id, point), 'shell-scrim', 'Shell overlay must win over the updater')
        const toggleBox = await toggle.boundingBox()
        assert.equal(await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.id,
          { x: toggleBox.x + 10, y: toggleBox.y + 10 }), 'shell-scrim', 'Shared overlay covers collapsed icon too')
        await page.mouse.click(point.x, point.y)
        assert.equal(await page.evaluate(() => overlayClicks), ++fixtureClicks, 'No click-through into updater')
        await page.locator('#chat-overlay').evaluate(node => { node.style.display = 'none' })
        if (phase === 'downloaded') {
          await host.locator('.action').click()
          await host.locator('.confirm').waitFor({ state: 'visible' })
          await assertReachable(host.locator('.later'), 'Confirmation dismiss remains reachable')
          await host.locator('.later').click()
        }
        await host.locator('.close').focus()
        await host.locator('.close').press('Escape')
        assert.equal(await panel.isVisible(), false)
        assert.equal(await toggle.evaluate(node => node.getRootNode().activeElement === node), true, 'Escape restores focus to update toggle')
        assert.equal(await page.evaluate(() => escapeLeaked), false, 'Escape must not close another app panel')
        cases++
      }
      // Large notes + confirmation must stay within a short viewport, with a scrollable panel.
      await page.evaluate(seq => emitUpdate({ payload: { seq, phase: 'downloaded', notes: 'Release notes\n'.repeat(80) } }), ++seq)
      await toggle.click()
      await host.locator('.action').click()
      const bounds = await panel.boundingBox()
      assert.ok(bounds.y >= 15 && bounds.y + bounds.height <= height - 109, 'Whole panel stays on screen')
      await assertReachable(host.locator('.diagnostics'), 'Long panel scrolls to bottom action')
      await host.locator('.close').click()
      await page.locator('#settings').click()
      await page.getByRole('textbox', { name: 'Message the agent' }).fill('draft stays editable')
      assert.equal(await page.evaluate(() => calls.includes('desktop_install_update')), false, 'Layer regression must never install/restart')
      assert.equal(await host.evaluate(node => getComputedStyle(node).zIndex), '11')
    }
  }
  assert.deepEqual(errors, [])
  assert.equal(cases, 24)
  console.log(`${engine}: ${cases} actual sticky-composer/updater/shell stacking cases + short viewport, long notes, confirmation, Escape/focus, editable draft passed; no installation invoked.`)

  // The real Shadow DOM must inherit the app's explicit scheme, including
  // when it disagrees with the OS. Native calls below are an isolated bridge
  // contract, not a claim that an actual Windows title bar was screenshot-tested.
  const palette=readFileSync(join(repo,'ui/src/modules/theme/design-platform.css'),'utf8')
  const neutral=readFileSync(join(repo,'ui/overrides/monochrome.css'),'utf8')
  const titlebarCss=readFileSync(join(repo,'ui/desktop/titlebar.css'),'utf8')
  const titlebar=scriptAsset('desktop-titlebar.js')
  const projection=createRequire(join(repo,'ui/package.json'))('esbuild').buildSync({entryPoints:[join(repo,'ui/src/modules/layout/theme-presenter.ts')],
    bundle:true,write:false,format:'iife',globalName:'ThemeProjection',platform:'browser',target:'es2020'}).outputFiles[0].text
  let paletteCases=0
  for(const os of ['light','dark']) {
    const themed=await browser.newPage({viewport:{width:1000,height:700},colorScheme:os,
      userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/605.1.15'})
    await themed.setContent(`<style>${palette} ${neutral} ${titlebarCss}
      body{margin:0;font:14px system-ui}#peer-sidebar{background:var(--dsw-specific-sidebar-fill);padding:54px 16px 16px;width:260px;height:100%}
      #peer-primary{background:var(--dsw-alias-button-info-fill);color:var(--dsw-alias-bg-base)}
      #peer-surface{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
      #peer-label{color:var(--dsw-alias-label-primary)}#peer-secondary{color:var(--dsw-alias-label-secondary)}
      #xharness-sidebar-updater-slot{position:absolute;left:16px;top:520px;width:200px}
      </style><aside id="peer-sidebar">Sidebar<button id="peer-primary">Primary action</button>
      <span id="peer-label">Label</span><span id="peer-secondary">Secondary label</span>
      <section id="peer-surface">Shared surface</section><div id="xharness-sidebar-updater-slot" hidden></div></aside>`)
    await themed.evaluate(()=>{
      window.themeCalls=[];window.calls=[];window.remote={seq:1,phase:'available',version:'9.9.9'}
      window.__TAURI__={
        core:{invoke:async command=>{calls.push(command);return command==='desktop_status'?{updaterConfigured:true}:remote}},
        event:{listen:async(_name,callback)=>{window.emitUpdate=callback;return()=>{}}},
        window:{getCurrentWindow:()=>({setTheme:async scheme=>{themeCalls.push(scheme)}})},
      }
    })
    await themed.addScriptTag({content:projection})
    await themed.evaluate(()=>{window.presenter=new ThemeProjection.ThemePresenter();presenter.apply({preference:'light',active:{id:'light',colorScheme:'light',tokens:{}},themes:[],revision:0})})
    await themed.addScriptTag({content:titlebar})
    await themed.addScriptTag({content:source})
    const update=themed.locator('#xharness-desktop-updater')
    await update.waitFor({state:'visible'})
    await update.locator('.toggle').click()
    await themed.mouse.move(950,650)
    let seq=1
    for(const app of ['light','dark','light']) {
      await themed.evaluate(scheme=>{
        presenter.apply({preference:scheme,active:{id:scheme,colorScheme:scheme,tokens:{}},themes:[],revision:1})
      },app)
      await themed.waitForFunction(scheme=>themeCalls.at(-1)===scheme,app)
      for(const phase of ['available','downloading','downloaded','error']) {
        await themed.evaluate(({seq,phase})=>emitUpdate({payload:{seq,phase,version:'9.9.9',downloaded:51,total:100,
          ...(phase==='error'?{retryAction:'download',message:'offline'}:{})}}),{seq:++seq,phase})
        const colors=await update.evaluate(host=>{
          const shadow=host.shadowRoot,style=selector=>getComputedStyle(shadow.querySelector(selector))
          const peer=selector=>getComputedStyle(document.querySelector(selector))
          return {scheme:getComputedStyle(host).colorScheme,
            bar:peer('#xh-desktop-titlebar').backgroundColor,sidebar:peer('#peer-sidebar').backgroundColor,
            background:style('.toggle').backgroundColor,foreground:style('.toggle').color,
            primary:peer('#peer-primary').backgroundColor,primaryText:peer('#peer-primary').color,
            secondaryText:peer('#peer-secondary').color,
            action:style('.action').backgroundColor,actionText:style('.action').color,
            panel:style('.panel').backgroundColor,surface:peer('#peer-surface').backgroundColor,
            progress:style('progress').accentColor}
        })
        assert.equal(colors.action,colors.primary,'update action shares the product primary color')
        assert.equal(colors.scheme,app,`OS=${os}/app=${app}: Shadow DOM follows the app, not the OS`)
        assert.equal(colors.bar,colors.sidebar,'HTML titlebar uses the shared chrome surface')
        assert.equal(colors.panel,colors.surface,'updater panel uses the app surface')
        assert.equal(colors.action,colors.primary);assert.equal(colors.actionText,colors.primaryText)
        assert.equal(colors.progress,colors.primary)
        if(phase==='error') {
          assert.equal(colors.background,'rgba(0, 0, 0, 0)');assert.equal(colors.foreground,colors.secondaryText)
        } else {
          assert.equal(colors.background,colors.primary);assert.equal(colors.foreground,colors.primaryText)
        }
        await themed.keyboard.press('Tab')
        await update.locator('.toggle').focus()
        assert.equal(await update.locator('.toggle').evaluate(button=>getComputedStyle(button).outlineColor),
          await themed.locator('#peer-label').evaluate(label=>getComputedStyle(label).color),'focus ring follows the app label color')
        paletteCases++
      }
      if(output&&os==='dark'&&app==='light') await themed.screenshot({path:join(output,`${engine}-os-dark-app-light.png`)})
    }
    await themed.evaluate(scheme=>presenter.apply({preference:'system',active:{id:scheme,colorScheme:scheme,tokens:{}},themes:[],revision:2}),os)
    await themed.waitForFunction(()=>themeCalls.at(-1)===null)
    await themed.emulateMedia({colorScheme:os==='light'?'dark':'light'})
    await themed.evaluate(scheme=>presenter.apply({preference:'system',active:{id:scheme,colorScheme:scheme,tokens:{}},themes:[],revision:3}),os==='light'?'dark':'light')
    await themed.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)))
    assert.deepEqual(await themed.evaluate(()=>themeCalls),['light','dark','light',null],'System releases native override; subsequent OS changes do not create a feedback loop')
    assert.equal(await themed.evaluate(()=>calls.includes('desktop_install_update')),false)
    await themed.close()
  }
  assert.equal(paletteCases,24)
  console.log(`${engine}: ${paletteCases} desktop palette cases passed; explicit light/dark overrides OS, shared titlebar/panel/buttons/focus/progress; native bridge synchronization only, no install.`)

  // Exercise the real bridge's boot/online timers, not only direct state injection.
  // Native package signature/cache validation is covered by Rust, never replaced
  // with a browser-side checksum. This mock must not touch a real feed/installer.
  for (const start of ['idle', 'downloaded', 'cache-hit', 'offline']) {
    const background = await browser.newPage({ viewport: { width: 900, height: 768 } })
    background.setDefaultTimeout(10000)
    const backgroundErrors = []
    background.on('pageerror', error => backgroundErrors.push(error.message))
    await background.setContent('<textarea aria-label="Task draft"></textarea>')
    await background.evaluate(start => {
      window.calls = []
      window.online = start !== 'offline'
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online })
      window.remote = { seq: 1, phase: start === 'downloaded' ? 'downloaded' : 'idle', version: '9.9.9' }
      window.__TAURI__ = {
        core: { invoke: async command => {
          calls.push(command)
          if (command === 'desktop_status') return { updaterConfigured: true }
          if (command === 'desktop_check_update') remote = { seq: remote.seq + 1, phase: start === 'cache-hit' ? 'downloaded' : 'available', version: '9.9.9' }
          if (command === 'desktop_download_update') {
            remote = { seq: remote.seq + 1, phase: 'downloading', version: '9.9.9', downloaded: 50, total: 100 }
            emitUpdate({ payload: remote })
            await new Promise(resolve => setTimeout(resolve, 350))
            remote = { seq: remote.seq + 1, phase: 'downloaded', version: '9.9.9', downloaded: 100, total: 100 }
          }
          if (command === 'desktop_install_update') throw Error('Test must not install')
          return remote
        } },
        event: { listen: async (_event, callback) => { window.emitUpdate = callback; return () => {} } },
      }
    }, start)
    await background.addScriptTag({ content: source })
    const update = background.locator('#xharness-desktop-updater')
    await update.waitFor({ state: 'visible' })
    const draft = background.getByRole('textbox', { name: 'Task draft' })
    await draft.fill('Task remains editable while a candidate is prepared')
    if (start === 'offline') {
      await background.waitForTimeout(1800)
      assert.equal(await background.evaluate(() => calls.includes('desktop_check_update')), false, 'Offline boot does not start repeated requests')
      await background.evaluate(() => { online = true; window.dispatchEvent(new Event('online')) })
    }
    if (start !== 'downloaded' && start !== 'cache-hit') {
      await background.waitForFunction(() => remote.phase === 'downloading')
      assert.equal(await update.locator('.panel').isVisible(), false, 'Background transfer never opens a panel')
      await draft.fill('Draft survives background transfer and network recovery')
    }
    await background.waitForFunction(() => remote.phase === 'downloaded')
    if (start === 'downloaded') await background.waitForTimeout(1800)
    assert.equal(await update.locator('.panel').isVisible(), false, 'Ready does not open a panel')
    assert.equal(await update.locator('.toggle').getAttribute('aria-expanded'), 'false')
    assert.ok((await draft.inputValue()).startsWith('Task remains') || (await draft.inputValue()).startsWith('Draft survives'))
    const requests = await background.evaluate(() => calls.filter(command => ['desktop_check_update', 'desktop_download_update'].includes(command)))
    assert.deepEqual(requests, start === 'downloaded' ? [] : start === 'cache-hit' ? ['desktop_check_update'] : ['desktop_check_update', 'desktop_download_update'])
    await update.locator('.toggle').click()
    assert.equal(await update.locator('.action').textContent(), '重启更新')
    await update.locator('.action').click()
    await update.locator('.confirm').waitFor({ state: 'visible' })
    await background.evaluate(() => window.dispatchEvent(new Event('online')))
    await update.locator('.later').click()
    await update.locator('.close').click()
    await draft.fill('Still working after choosing later')
    assert.equal(await background.evaluate(() => calls.includes('desktop_install_update')), false, 'Neither online, Ready nor later grants install consent')
    assert.deepEqual(backgroundErrors, [])
    await background.close()
  }
  console.log(`${engine}: 4 background preparation cases passed (boot download, restored Ready, fresh-manifest cache hit, offline-to-online); no panel takeover or installation, editable draft and explicit confirmation retained.`)
} finally { await browser.close() }
