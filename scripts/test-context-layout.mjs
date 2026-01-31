#!/usr/bin/env node
// Real layout regression using the shipped upstream CSS and product plugin.
// UI_TEST_DEPS points at a directory with node_modules/{playwright,react,react-dom}.
// Does not connect to a running Harness or load any user conversations.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(resolve(process.env.UI_TEST_DEPS ?? repo, 'package.json'))
const { chromium, webkit } = require('playwright')
const engine = process.env.UI_TEST_BROWSER ?? 'chromium'
assert.ok(['chromium', 'webkit'].includes(engine))
const bundle = readFileSync(join(repo, 'ui/dist/plugins/@deepseek-ai/dsh-client-ui-conversation/client.js'), 'utf8')
// Fail loudly on upstream contract changes instead of testing stale copied CSS.
const cssLine = bundle.split('\n').find(line => line.includes('const css') && line.includes('[data-conversation-composer-overlay]'))
assert.ok(cssLine, 'upstream composer overlay CSS must exist')
const css = JSON.parse(cssLine.trim().match(/^const \S+ = (".*");$/)[1])
const classBlock = bundle.match(/var ConversationRoot_module_css_default = \{([\s\S]*?)\};/)[1]
const classes = Object.fromEntries([...classBlock.matchAll(/"(\w+)": "([^"]+)"/g)].map(m => [m[1],m[2]]))
const source = readFileSync(process.env.UI_TEST_PLUGIN ?? join(repo, 'ui/plugins/@xlang/xharness-client-ui-context/client.js'), 'utf8')
const browser = await ({chromium, webkit}[engine]).launch({
  headless: true,
  ...(process.env.UI_TEST_EXECUTABLE ? {executablePath: process.env.UI_TEST_EXECUTABLE} : {}),
})
let cases = 0
try {
  const page = await browser.newPage({viewport: {width:1254, height:768}})
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setContent(`<style>html,body{margin:0;height:100%}*{box-sizing:border-box}:root{--dsw-alias-bg-base:white;--dsh-scrollbar-width:8px}${css}</style>
    <div class="${classes.root}" data-phase="active"><header class="${classes.header}" style="height:90px">Chat / Context / Harness</header>
    <div class="${classes.scrollBody}" data-conversation-scroll style="--dsh-composer-height:116px">
    <div data-slot="conversation.session" style="display:contents"><div class="${classes.viewArea}"><div id="mount" style="display:contents"></div></div></div>
    <div class="${classes.composerSeat}" data-composer-seat style="height:116px">Composer</div></div></div>`)
  for (const [pkg, file] of [['react', 'react.development.js'], ['react-dom','react-dom.development.js']]) {
    await page.addScriptTag({path:join(dirname(require.resolve(`${pkg}/package.json`)), 'umd', file)})
  }
  await page.evaluate(() => { window.__ModuleLoader__ = {load: registration => {window.registration = registration}} })
  await page.addScriptTag({content: source})
  await page.evaluate(() => {
    const tabs = []
    registration.factory(() => React).apply({effect: fn => fn(), conversationEvents:{register(){}}, conversationViews:{register(){}},
      slots:{inject:(_,fn)=>fn(), register:(options, component)=>tabs.push({options,component})}})
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
      : React.createElement(tabs.find(tab=>tab.options.id===id).component, {useSession})))
  })
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
    for (const tab of ['harness','context']) {
      for (let iteration=0; iteration<3; iteration++) {
        await page.evaluate(() => { renderTab('chat');document.querySelector('[data-conversation-scroll]').scrollTop=15000 })
        assert.ok(await page.evaluate(()=>document.querySelector('[data-conversation-scroll]').scrollTop>10000))
        await page.evaluate(tab=>renderTab(tab), tab)
        const m = await bounded(`${tab} ${width} switch ${iteration}`)
        assert.ok(m.inner.excess>100, 'long content must scroll, not shrink/clip')
        // Updating the current snapshot must not reset the reader's scroll.
        const before=await page.evaluate(()=>{const e=document.querySelector('.xhctx-root');e.scrollTop=180;return e.scrollTop})
        await page.evaluate(tab=>{snapshot={...snapshot,requests:[...snapshot.requests,{...requestFixture,seq:snapshot.requests.length+1}]};renderTab(tab)},tab)
        assert.ok(Math.abs((await metrics()).inner.topScroll-before)<2, 'stream update must preserve reading position')
      }
    }
  }
  // Same request selection and tool expansion remain interactive.
  await page.evaluate(()=>renderTab('harness'))
  await page.locator('[aria-label="选择 Harness 请求"]').selectOption('1')
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
    const bottom=await page.locator('.xhctx-harness-columns').evaluate(e=>e.getBoundingClientRect().bottom)
    assert.ok(bottom<=m.composer.top, 'last panel must be readable above composer')
  }
  for (const requests of [[], [{seq:999,header:{input:[],tools:[]}}]]) {
    for (const tab of ['context','harness']) {
      await page.evaluate(({requests,tab})=>{snapshot={requests,compactions:[]};renderTab(tab)},{requests,tab})
      await bounded(`${tab} empty/short`)
    }
  }
  assert.deepEqual(errors, [], 'no render exceptions')
  console.log(`${engine}: ${cases} layout cases passed (switching, live snapshots, tools, resize, composer, empty)`)
} finally { await browser.close() }
