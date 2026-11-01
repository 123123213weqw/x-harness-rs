#!/usr/bin/env node
// Real layout regression using the shipped upstream CSS and product plugin.
// UI_TEST_DEPS points at a directory with node_modules/{playwright,react,react-dom}.
// Does not connect to a running Harness or load any user conversations.
import assert from 'node:assert/strict'
import {mkdirSync,readFileSync,readdirSync} from 'node:fs'
import {exposeConversation} from './conversation-artifact-test.mjs'
import {installOwnedViewPlatform} from './fixtures/owned-view-platform-browser.mjs'
import { createRequire } from 'node:module'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyArtifact, shippedUnitValue } from './fixtures/shipped-source-values.mjs'
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(resolve(process.env.UI_TEST_DEPS ?? repo, 'package.json'))
const { chromium, webkit } = require('playwright')
const engine = process.env.UI_TEST_BROWSER ?? 'chromium'
assert.ok(['chromium', 'webkit'].includes(engine))
// Read exact AST-scoped values from the canonical CSS and class-map units;
// never depend on the old bundle's emitted variable names or copied CSS.
const conversation=verifyArtifact('@xharness/dsh-client-ui-conversation')
const css=shippedUnitValue(conversation,'src/modules/conversation/skeleton/ConversationRoot.css')
const classes=shippedUnitValue(conversation,'src/modules/conversation/skeleton/ConversationRoot.styles.js')
assert.ok(css.includes('[data-conversation-composer-overlay]'),'shipped composer overlay CSS must exist')
for(const name of ['root','header','scrollBody','viewArea','composerSeat'])assert.equal(typeof classes[name],'string')
const source=verifyArtifact('@xlang/xharness-client-ui-context')
const theme=shippedUnitValue(verifyArtifact('@xharness/dsh-client-ui-theme'),'src/modules/theme/design-platform.css')
const monochrome=readFileSync(join(repo,'ui/dist/monochrome.css'),'utf8')
const browser = await ({chromium, webkit}[engine]).launch({
  headless: true,
  ...(process.env.UI_TEST_EXECUTABLE ? {executablePath: process.env.UI_TEST_EXECUTABLE} : {}),
})
let cases = 0
const screenshotDir=process.env.UI_TEST_SCREENSHOT_DIR
if(screenshotDir)mkdirSync(screenshotDir,{recursive:true})
try {
  const page = await browser.newPage({viewport: {width:1254, height:768}})
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setContent(`<style>html,body{margin:0;height:100%}*{box-sizing:border-box}:root{--dsw-alias-bg-base:white;--dsh-scrollbar-width:8px}${css}${theme}${monochrome}</style>
    <div class="${classes.root}" data-phase="active"><header class="${classes.header}" style="height:90px">Chat / Harness</header>
    <div class="${classes.scrollBody}" data-conversation-scroll style="--dsh-composer-height:116px">
    <div data-slot="conversation.session" style="display:contents"><div class="${classes.viewArea}"><div id="mount" style="display:contents"></div></div></div>
    <div class="${classes.composerSeat}" data-composer-seat style="height:116px">Composer</div></div></div>`)
  for (const [pkg, file] of [['react', 'react.development.js'], ['react-dom','react-dom.development.js']]) {
    await page.addScriptTag({path:join(dirname(require.resolve(`${pkg}/package.json`)), 'umd', file)})
  }
  await page.evaluate(() => { window.__ModuleLoader__ = {load: registration => {window.registration = registration}} })
  await page.addScriptTag({content: source})
  await page.evaluate(() => {
    const tabs = [], labels = new Map()
    window.fixtureLocale='zh';window.fixtureSessionId='fixture';
    registration.factory(() => React).apply({effect: fn => fn(), locale:{register:(ns,dict)=>labels.set(ns,dict),bind:ns=>key=>labels.get(ns)[fixtureLocale][key]}, conversationEvents:{register(){}}, conversationViews:{register(){}},
      slots:{inject:(_,fn)=>fn(), register:(options, component)=>tabs.push({options,component})}})
    window.registeredTabs=tabs.map(tab=>tab.options.id)
    const request = {seq:1, header:{config:{model:'fixture-model'}, system:'Coding prompt '.repeat(200),
      input: Array.from({length:100}, (_,i)=>({role:'user',content:`Message ${i} ` + 'history '.repeat(50)})),
      tools:Array.from({length:14},(_,i)=>({name:`tool_${i}`,description:'Tool description '.repeat(30),parameters:{type:'object'}})),
      options:{prompt:{sections:[{id:'coding',version:'1'}]}}}}
    window.snapshot = {requests:[request], compactions:[]}
    window.requestFixture = request
    const root = ReactDOM.createRoot(document.querySelector('#mount'))
    const useSession = select => select({views:new Map([['xharness-context',snapshot]])})
    window.renderTab = id => ReactDOM.flushSync(() => root.render(id === 'chat'
      ? React.createElement('div',{style:{height:15000}},'Long Chat fixture')
      : React.createElement(tabs.find(tab=>tab.options.id===id).component, {useSession,sessionId:fixtureSessionId,...tabs.find(tab=>tab.options.id===id).options.inject?.()})))
  })
  assert.deepEqual(await page.evaluate(()=>registeredTabs), ['harness'], 'Context tab is no longer registered')
  const metrics = () => page.evaluate(() => {
    const outer = document.querySelector('[data-conversation-scroll]')
    const inner = document.querySelector('.xhctx-root')
    const composer = document.querySelector('[data-composer-seat]')
    const box = element => {const r=element.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height}}
    return {outer:{...box(outer),topScroll:outer.scrollTop,excess:outer.scrollHeight-outer.clientHeight},
      inner:{...box(inner),topScroll:inner.scrollTop,excess:inner.scrollHeight-inner.clientHeight,
        padding:parseFloat(getComputedStyle(inner).paddingBottom)}, composer:box(composer)}
  })
  const bounded = async label => {
    const m = await metrics()
    assert.ok(Math.abs(m.outer.topScroll)<2, `${label}: stale outer scroll: ${JSON.stringify(m)}`)
    assert.ok(m.outer.excess<2, `${label}: outer must not scroll`)
    assert.ok(Math.abs(m.inner.top-m.outer.top)<2 && m.inner.height>100, `${label}: view inside viewport`)
    assert.ok(m.composer.bottom<=768+1, `${label}: composer visible`)
    cases++
    return m
  }
  for (const width of [1254,600]) {
    await page.setViewportSize({width,height:768})
    for (const tab of ['harness']) {
      for (let iteration=0; iteration<3; iteration++) {
        await page.evaluate(() => { renderTab('chat');document.querySelector('[data-conversation-scroll]').scrollTop=15000 })
        assert.ok(await page.evaluate(()=>document.querySelector('[data-conversation-scroll]').scrollTop>10000))
        await page.evaluate(tab=>renderTab(tab), tab)
        const m = await bounded(`${tab} ${width} switch ${iteration}`)
        assert.ok(m.inner.excess>100, 'long content must scroll, not shrink/clip')
        // Updating the current snapshot must not reset the reader's scroll.
        const before=await page.evaluate(()=>{const e=document.querySelector('.xhctx-root');e.scrollTop=180;return e.scrollTop})
        await page.evaluate(tab=>{snapshot={...snapshot,requests:[...snapshot.requests,{...requestFixture,seq:snapshot.requests.length+1}]};renderTab(tab)},tab)
        const after=(await metrics()).inner.topScroll;assert.ok(Math.abs(after-before)<2, `${tab} ${width}: stream update must preserve reading position: ${before} -> ${after}`)
      }
    }
  }
  // Same request selection and tool expansion remain interactive.
  await page.evaluate(()=>renderTab('harness'))
  await page.locator('[aria-label="选择请求"]').selectOption('1')
  await page.locator('.xhctx-registry-tool summary').first().click()
  assert.equal(await page.locator('.xhctx-registry-tool').first().getAttribute('open'), '')
  await bounded('expanded tool')
  for (const height of [116,300]) {
    await page.evaluate(height=>{
      document.querySelector('[data-composer-seat]').style.height=`${height}px`
      document.querySelector('[data-conversation-scroll]').style.setProperty('--dsh-composer-height',`${height}px`)
      const e=document.querySelector('.xhctx-root');e.scrollTop=e.scrollHeight
    },height)
    const m=await bounded(`composer ${height}`)
    assert.ok(m.inner.padding>=height+24, 'reserve actual composer height')
    const bottom=await page.locator('.xhctx-tools-panel').evaluate(e=>e.getBoundingClientRect().bottom)
    assert.ok(bottom<=m.composer.top, 'last panel must be readable above composer')
  }
  // Payload-only design, keyboard disclosure, search, languages and reuse across chats.
  await page.evaluate(()=>{snapshot={requests:[requestFixture,{...requestFixture,seq:2}],compactions:[]};renderTab('harness')})
  assert.deepEqual(await page.locator('.xhctx-panel h3').allTextContents(),['系统提示词','工具'])
  assert.equal(await page.locator('.xhctx-pipeline,.xhctx-assembly-section,.xhctx-harness-columns').count(),0)
  assert.equal(await page.locator('.xhctx-system-text').textContent(),await page.evaluate(()=>requestFixture.header.system))
  await page.getByRole('combobox',{name:'选择请求'}).selectOption('2')
  const search=page.getByRole('searchbox',{name:'搜索工具',exact:true})
  await search.fill('TOOL_13')
  assert.equal(await page.locator('.xhctx-registry-tool').count(),1)
  assert.equal(await page.locator('.xhctx-registry-tool code').textContent(),'tool_13')
  await search.fill('No such tool')
  await page.getByText('没有匹配的工具。',{exact:true}).waitFor()
  await search.fill('tool_0')
  const summary=page.locator('.xhctx-registry-tool summary').first()
  await summary.focus();await page.keyboard.press('Enter')
  assert.equal(await page.locator('.xhctx-registry-tool').first().getAttribute('open'),'')
  await page.getByRole('combobox',{name:'选择请求',exact:true}).selectOption('1')
  assert.equal(await page.locator('.xhctx-registry-tool').first().getAttribute('open'),null,'new request has its own expansion state')
  await page.evaluate(()=>{fixtureSessionId='other';snapshot={requests:[{...requestFixture,seq:3}],compactions:[]};renderTab('harness')})
  assert.equal(await search.inputValue(),'','search does not leak to another chat')
  assert.equal(await page.locator('.xhctx-registry-tool').count(),14)
  await page.evaluate(()=>{fixtureSessionId='fixture';snapshot={requests:[requestFixture,{...requestFixture,seq:2}],compactions:[]};renderTab('harness')})
  assert.equal(await search.inputValue(),'','returning to a chat does not resurrect an old filter')
  assert.equal(await page.getByRole('combobox',{name:'选择请求'}).inputValue(),'2','returning follows latest request')
  await search.fill('tool_0')
  await page.evaluate(()=>{
    // Keep both transitions in one task so passive effects cannot hide a race.
    fixtureSessionId='other';snapshot={requests:[{...requestFixture,seq:3}],compactions:[]};renderTab('harness')
    fixtureSessionId='fixture';snapshot={requests:[requestFixture,{...requestFixture,seq:2}],compactions:[]};renderTab('harness')
  })
  assert.equal(await search.inputValue(),'','rapid round-trip switches clear stale filters before paint')
  assert.equal(await page.locator('.xhctx-registry-tool').count(),14)
  assert.equal(await page.getByRole('combobox',{name:'选择请求'}).inputValue(),'2')
  await page.evaluate(()=>{fixtureLocale='en';renderTab('harness')})
  assert.deepEqual(await page.locator('.xhctx-panel h3').allTextContents(),['System prompt','Tools'])
  await page.getByRole('searchbox',{name:'Search tools',exact:true}).fill('description')
  assert.equal(await page.locator('.xhctx-registry-tool').count(),14,'search covers descriptions')
  await page.getByRole('searchbox',{name:'Search tools',exact:true}).fill('')
  await page.evaluate(()=>{
    // A compact visual fixture, separate from the long-history layout assertions.
    snapshot={requests:[{seq:1,header:{system:'You are XHarness, a coding assistant.\nRead the workspace before editing. Reuse existing modules and verify changes with tests.\nReport the result clearly and keep user data local.',tools:[
      {name:'bash',description:'Run a command in the workspace.',parameters:{type:'object',properties:{command:{type:'string'}}}},
      {name:'read',description:'Read a workspace file.',parameters:{type:'object',properties:{path:{type:'string'}}}},
      {name:'write',description:'Write a workspace file.',parameters:{type:'object',properties:{path:{type:'string'},content:{type:'string'}}}},
      {name:'agent',description:'Delegate a task to a child agent.',parameters:{type:'object'}},
    ],options:{}}}],compactions:[]};renderTab('harness')
    document.body.style.font='14px system-ui,sans-serif'
    document.querySelector('header').style.color='var(--dsw-alias-label-primary)'
    document.querySelector('[data-composer-seat]').style.height='116px'
    document.querySelector('[data-conversation-scroll]').style.setProperty('--dsh-composer-height','116px')
  })
  await page.setViewportSize({width:900,height:768})
  // Deliberately invert OS preference: explicit shell tokens must control Harness.
  for(const dark of [false,true]) {
    await page.emulateMedia({colorScheme:dark?'light':'dark'})
    await page.evaluate(dark=>{
      document.body.toggleAttribute('data-ds-dark-theme',dark)
      document.querySelector('.xhctx-root').scrollTop=0
    },dark)
    const colors=await page.locator('.xhctx-harness-root').evaluate(e=>{
      const style=getComputedStyle(e),probe=document.createElement('span');e.append(probe)
      probe.style.color='var(--dsw-alias-label-primary)';probe.style.background='var(--dsw-alias-bg-base)'
      const expected={bg:getComputedStyle(probe).backgroundColor,color:getComputedStyle(probe).color};probe.remove()
      return {actual:{bg:style.backgroundColor,color:style.color},expected}
    })
    assert.deepEqual(colors.actual,colors.expected,'manual shell theme, not OS preference, owns Harness colors')
    const promptColors=await page.locator('.xhctx-system-text').evaluate(e=>({bg:getComputedStyle(e).backgroundColor,color:getComputedStyle(e).color}))
    assert.notEqual(promptColors.bg,promptColors.color,'prompt text remains readable in both themes')
    if(screenshotDir)await page.screenshot({path:join(screenshotDir,`${engine}-harness-${dark?'dark':'light'}.png`)})
    cases++
  }
  await page.evaluate(()=>{fixtureLocale='zh';snapshot={requests:[{...requestFixture,header:{...requestFixture.header,system:'x'.repeat(10000),tools:[{name:'long_name_'.repeat(100),description:'中文'.repeat(100),parameters:{type:'object'}}]}}],compactions:[]};renderTab('harness')})
  await page.setViewportSize({width:320,height:768})
  assert.ok(await page.locator('.xhctx-root').evaluate(e=>e.scrollWidth-e.clientWidth<2),'long prompt/tool names do not cause horizontal scrolling')
  await bounded('320px long prompt/name')
  await page.setViewportSize({width:600,height:768})
  cases++
  for (const requests of [[], [{seq:999,header:{input:[],tools:[]}}]]) {
    for (const tab of ['harness']) {
      await page.evaluate(({requests,tab})=>{snapshot={requests,compactions:[]};renderTab(tab)},{requests,tab})
      await bounded(`${tab} empty/short`)
    }
  }
  // The real React component must expose provenance, not just role buckets.
  const meterPage=await browser.newPage({viewport:{width:600,height:900}})
  await installOwnedViewPlatform(meterPage,'source')
  meterPage.on('pageerror',error=>errors.push(error.message))
  await meterPage.evaluate(()=>{document.getElementById('root').replaceChildren();document.getElementById('root').hidden=true;window.registrations={};window.__ModuleLoader__={load:registration=>{registrations[registration.id]=registration}}})
  for(const name of readdirSync(join(repo,'ui/dist/plugins/@xharness'))) {
    let artifact=readFileSync(join(repo,'ui/dist/plugins/@xharness',name,'client.js'),'utf8')
    if(name==='dsh-client-ui-conversation')artifact=exposeConversation(artifact,['ContextMeter','en'])
    await meterPage.addScriptTag({content:artifact})
  }
  await meterPage.evaluate(()=>{
    const cache={};function load(id){if(staticModules[id])return staticModules[id];const name=id.endsWith('/client')?id.slice(0,-7):id;return cache[name]??=registrations[name].factory(load)}
    const conversation=load('@xharness/dsh-client-ui-conversation/client')
    const themeCtx={effect:fn=>fn(),provide:(name,value)=>{themeCtx[name]=value},on:()=>{},emit:()=>{},settingsScope:{bind:()=>({subscribe:()=>()=>{},getSnapshot:()=>({value:{preference:'light'}})})},locale:{register:()=>()=>{}},slots:{inject:()=>{}}}
    load('@xharness/dsh-client-ui-theme/client').apply(themeCtx)
    for(const [name,value] of Object.entries(themeCtx.theme.getTheme().active.tokens))document.documentElement.style.setProperty(name,value)
    const mount=document.createElement('div');document.body.appendChild(mount)
    mount.style.cssText='position:fixed;right:24px;bottom:24px;width:28px;height:28px'
    const root=ReactDOM.createRoot(mount)
    document.body.style.cssText='font:14px system-ui;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)'
    window.renderMeter=composition=>ReactDOM.flushSync(()=>root.render(React.createElement(conversation.ContextMeter,{
      useProjection:()=>({contextWindow:1000,pressureTokens:500,pressureAccuracy:'provider_reported',phase:'history_changed',composition}),
      t:(key,params)=>Object.entries(params??{}).reduce((text,[name,value])=>text.replace('{'+name+'}',String(value)),conversation.en[key]??key),
    })))
  })
  const composition={attributionVersion:2,systemTokens:5,userTokens:2,agentReportTokens:40,runtimeContextTokens:20,checkpointTokens:10,unattributedTokens:3,assistantTokens:10,toolResultTokens:5,toolDefinitionTokens:4,protocolTokens:1}
  await meterPage.evaluate(composition=>renderMeter(composition),composition)
  await meterPage.getByRole('button').click()
  const panel=meterPage.getByRole('dialog')
  assert.deepEqual(await panel.locator('dt').allTextContents(),['System prompt','Your messages','Agent reports','Runtime context','Checkpoints','Unattributed context','Assistant','Tool results','Tools','Protocol overhead'])
  assert.ok((await panel.innerText()).includes('500 / 1K'))
  assert.equal((await panel.locator('dd').allTextContents())[1],'≈10')
  assert.equal((await panel.locator('dd').allTextContents())[2],'≈200')
  for(const width of [600,360]) {
    await meterPage.setViewportSize({width,height:900})
    assert.ok(await panel.evaluate(element=>{const box=element.getBoundingClientRect();return box.left>=0&&box.right<=innerWidth&&box.top>=0&&box.bottom<=innerHeight}),'category panel remains within the viewport')
  }
  if(screenshotDir)await meterPage.screenshot({path:join(screenshotDir,`${engine}-context-provenance.png`)})
  await meterPage.evaluate(composition=>renderMeter({...composition,attributionVersion:undefined}),composition)
  assert.equal(await panel.getByText('Your messages',{exact:true}).count(),0)
  assert.equal(await panel.getByText('User-role history (source unknown)',{exact:true}).count(),1)
  await meterPage.keyboard.press('Escape')
  assert.equal(await meterPage.getByRole('dialog').count(),0)
  await meterPage.close()
  cases+=3
  assert.deepEqual(errors, [], 'no render exceptions')
  console.log(`${engine}: ${cases} layout cases passed (switching, live snapshots, tools, resize, composer, empty)`)
} finally { await browser.close() }
