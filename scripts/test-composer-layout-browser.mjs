// Production components, real input machine and palettes; fake Host receipts.
// Exercise long model names and the same actions at desktop and split-pane sizes.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdirSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {composerPreview} from './fixtures/composer-layout-preview.mjs'
import {verifyConversationArtifact} from './conversation-artifact-test.mjs'
import {verifyArtifact} from './fixtures/shipped-source-values.mjs'
verifyConversationArtifact()
verifyArtifact('@xharness/dsh-client-ui-goal')
verifyArtifact('@xharness/dsh-client-ui-model-selection')
const require=createRequire(resolve(process.env.UI_TEST_DEPS??'/tmp/ui-tests','package.json'))
const engine=process.env.UI_TEST_BROWSER??'chromium',browser=await require('playwright')[engine].launch({headless:true})
const server=composerPreview(),output=resolve(process.env.UI_TEST_OUTPUT??'dist/composer-layout')
mkdirSync(output,{recursive:true})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const readings=[]
try {
  const page=await browser.newPage({viewport:{width:1280,height:780}}),errors=[]
  page.on('pageerror',error=>errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.locator('[data-composer-stats]').waitFor()
  const set=async changes=>{await page.evaluate(changes=>window.__composerFixture.set(changes),changes)}
  const geometry=()=>page.evaluate(()=>{
    const card=document.querySelector('[data-composer-card]'),toolbar=document.querySelector('[data-composer-toolbar]'),actions=document.querySelector('[data-composer-actions]')
    const box=el=>{const {x,y,width,height}=el.getBoundingClientRect();return {x,y,width,height}}
    return {viewport:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,card:box(card),toolbar:box(toolbar),actions:box(actions),buttons:[...actions.children].map(box),model:[...document.querySelectorAll('[data-xh-model-control]')].map(box),goalInCard:card.contains(document.querySelector('[data-goal-bar]')),statsInCard:card.contains(document.querySelector('[data-composer-stats]'))}
  })
  for(const dark of [false,true]) for(const width of [1280,900,720,600,560,540,520,430,375,320]) {
    await page.setViewportSize({width,height:780})
    await set({dark})
    const layout=await geometry();readings.push({dark,...layout})
    assert.equal(layout.overflow,false,JSON.stringify(layout))
    assert.equal(layout.goalInCard,true)
    assert.equal(layout.statsInCard,true)
    assert.ok(layout.card.x>=0&&layout.card.x+layout.card.width<=width,JSON.stringify(layout))
    assert.ok(layout.actions.width<=150&&layout.actions.height<=36,JSON.stringify(layout))
    for(const control of [...layout.model,...layout.buttons]) {
      assert.ok(control.width>=24&&control.height>=24,JSON.stringify(layout))
      assert.ok(control.x>=layout.card.x&&control.x+control.width<=layout.card.x+layout.card.width+1,JSON.stringify(layout))
    }
    for(const control of layout.buttons) assert.ok(Math.abs(control.y+control.height/2-(layout.actions.y+layout.actions.height/2))<=1,JSON.stringify(layout))
    assert.ok(layout.toolbar.height<=54,JSON.stringify(layout))
    if([1280,375].includes(width)) {
      await page.screenshot({path:resolve(output,`${engine}-${dark?'dark':'light'}-${width}.png`)})
      await page.locator('[data-composer-card]').screenshot({path:resolve(output,`${engine}-${dark?'dark':'light'}-${width}-card.png`),animations:'disabled'})
    }
  }
  // Explicit overflow stress: extreme provider names cannot displace Stop.
  await set({longName:'A deliberately very long provider model identifier '.repeat(5)})
  for(const width of [900,560,375,320]) {
    await page.setViewportSize({width,height:780})
    const layout=await geometry()
    assert.equal(layout.overflow,false,JSON.stringify(layout))
    assert.ok(layout.model.every(box=>box.width>=28),JSON.stringify(layout))
    assert.ok(layout.actions.x+layout.actions.width<=layout.card.x+layout.card.width,JSON.stringify(layout))
  }
  await set({longName:'qwen3.8-27b-uncensored',dark:false})
  await page.setViewportSize({width:900,height:780})
  // Real platform Menu and native picker, not a mock popup or synthetic change event.
  for(let attempt=0;attempt<3;attempt++) {
    await page.getByRole('button',{name:'Add attachments or commands',exact:true}).click()
    const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.getByRole('menuitem',{name:'Add images or files',exact:true}).click()])
    await chooser.setFiles({name:`fixture-${attempt}.txt`,mimeType:'text/plain',buffer:Buffer.from('isolated attachment')})
    await page.waitForFunction(name=>__composerFixture.calls.some(call=>call.attachments?.includes(name)),`fixture-${attempt}.txt`)
  }
  // Draft/caret survive Goal, stats, theme and viewport changes.
  const input=page.locator('textarea')
  await input.fill('Keep this draft')
  await input.press('ArrowLeft')
  const caret=await input.evaluate(el=>el.selectionStart)
  await set({goal:false,stats:false,dark:true})
  await page.setViewportSize({width:375,height:780})
  await set({goal:true,stats:true})
  assert.equal(await input.inputValue(),'Keep this draft')
  assert.equal(await input.evaluate(el=>el.selectionStart),caret)
  // Main-session Stop stays primary; Enter retains the existing queue gesture.
  await page.getByRole('button',{name:'Stop generating',exact:true}).click()
  assert.equal(await page.evaluate(()=>__composerFixture.calls.filter(call=>call.stop).length),1)
  await input.press('Enter')
  await page.waitForFunction(()=>__composerFixture.calls.some(call=>call.send==='Keep this draft'))
  assert.equal(await page.evaluate(()=>__composerFixture.calls.find(call=>call.send).mode),'queue')
  await page.waitForFunction(()=>document.querySelector('textarea').value==='')
  // Addressed children retain independent Stop and Send actions at narrow widths.
  await set({subagent:{address:{mode:'continuable'},parentAvailable:true}})
  await input.fill('Child follow-up')
  assert.equal(await page.getByRole('button',{name:'Stop generating',exact:true}).count(),1)
  await page.getByRole('button',{name:'Send message',exact:true}).click()
  await page.waitForFunction(()=>__composerFixture.calls.some(call=>call.send==='Child follow-up'))
  for(const width of [375,320]) {
    await page.setViewportSize({width,height:780})
    const layout=await geometry()
    assert.equal(layout.overflow,false,JSON.stringify(layout))
    assert.ok(layout.actions.x+layout.actions.width<=layout.card.x+layout.card.width+1,JSON.stringify(layout))
  }
  await set({running:false,subagent:null})
  await input.fill('Send in idle mode')
  await page.getByRole('button',{name:'Send message',exact:true}).click()
  await page.waitForFunction(()=>__composerFixture.calls.some(call=>call.send==='Send in idle mode'))
  // Stats disclosure is keyboard operable, not hover-only or clipped.
  const summary=page.locator('[data-composer-stats] > button')
  await summary.focus();await summary.press('Enter')
  assert.equal(await summary.getAttribute('aria-expanded'),'true')
  assert.match(await page.locator('[data-composer-stats]').innerText(),/Cache hit/)
  assert.match(await page.locator('[data-composer-stats]').innerText(),/Input.*Output/)
  const statsBox=await page.locator('[data-composer-stats] > div').boundingBox()
  assert.ok(statsBox.x>=0&&statsBox.x+statsBox.width<=page.viewportSize().width&&statsBox.y>=0,JSON.stringify(statsBox))
  await summary.press('Escape')
  assert.equal(await summary.getAttribute('aria-expanded'),'false')
  await summary.press('Enter')
  await page.locator('.preview-transcript h1').click()
  assert.equal(await summary.getAttribute('aria-expanded'),'false')
  assert.equal(await page.locator('[data-composer-stats] > div').isVisible(),false)
  await input.click()
  // Both supported locales label the actual disclosure and its region.
  for (const [locale, label] of [['zh', '对话统计'], ['en', 'Conversation statistics']]) {
    await set({locale})
    assert.equal(await summary.getAttribute('aria-label'), label)
    assert.equal(await summary.getAttribute('title'), label)
    await summary.click()
    await page.getByRole('region', {name: label, exact: true}).waitFor()
    await summary.press('Escape')
  }
  // Existing Goal editing and budget forms still fit the integrated header.
  await page.getByRole('button',{name:'Resume goal',exact:true}).click()
  assert.equal(await page.evaluate(()=>__composerFixture.calls.at(-1).goal),'resume')
  await page.getByRole('button',{name:'Edit goal',exact:true}).click()
  await page.getByRole('textbox',{name:'Goal objective',exact:true}).fill('Updated preview goal')
  await page.getByRole('button',{name:'Save goal',exact:true}).click()
  await page.waitForFunction(()=>__composerFixture.calls.some(call=>call.goal==='edit'&&call.value==='Updated preview goal'))
  await page.getByRole('button',{name:'预算',exact:true}).click()
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
  await page.getByRole('spinbutton').fill('30')
  await page.getByRole('button',{name:'保存轮数预算',exact:true}).click()
  await page.waitForFunction(()=>__composerFixture.calls.some(call=>call.goal==='budget'&&call.value===30))
  // Todo remains independent and fully readable; removing all docks leaves no empty header/footer.
  await set({todos:[{id:'1',content:'Verify parser cases',status:'in_progress'},{id:'2',content:'Review the result',status:'pending'}]})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
  // Checklist presentation is visible by default and never changes execution.
  await set({todos:[{content:'Review existing server',status:'completed'},{content:'Implement request routing',status:'in_progress'},{content:'Run load tests',status:'pending'}]})
  const todo=page.getByTestId('todo-panel')
  assert.equal(await todo.getByRole('button').getAttribute('aria-expanded'),'true')
  assert.match(await todo.innerText(),/1\/3/)
  assert.equal(await todo.locator('li').count(),3)
  assert.match(await todo.locator('[data-status="completed"] .Xe4JHW_content').evaluate(el=>getComputedStyle(el).textDecorationLine),/line-through/)
  await todo.getByRole('button').press('Enter')
  assert.equal(await todo.locator('li').count(),0)
  await todo.getByRole('button').press('Enter')
  assert.equal(await todo.locator('li').count(),3)
  await set({todos:[],taskPlan:{revision:1,items:[{id:'done',title:'Review existing server',status:'completed'},{id:'run',title:'Implement request routing',status:'in_progress'},{id:'next',title:'Run load tests '+'long unbroken title '.repeat(40),status:'pending'}]}})
  const progress=page.locator('[data-task-plan-revision]')
  for(const width of [1280,375,320]) {
    await page.setViewportSize({width,height:780})
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
    const style=await progress.locator('details').evaluate(el=>({border:getComputedStyle(el).borderTopWidth,width:el.getBoundingClientRect().width,parent:el.parentElement.getBoundingClientRect().width}))
    assert.equal(style.border,'0px')
    assert.ok(Math.abs(style.width-style.parent)<=1)
    assert.match(await progress.locator('[data-plan-status="completed"] .xh-progress-item').evaluate(el=>getComputedStyle(el).textDecorationLine),/line-through/)
  }
  await set({taskPlan:null,queue:[{id:'preview-queue',placement:'queued',text:'continue',preview:'continue'}]})
  assert.equal(await progress.count(),0)
  await page.getByRole('button',{name:'Edit queued message',exact:true}).click()
  const queueInput=page.locator('[data-queue-dock] input')
  await queueInput.fill('continue after review')
  await queueInput.press('Enter')
  await page.getByText('continue after review',{exact:true}).waitFor()
  await page.getByRole('button',{name:'Remove queued message',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('[data-queue-dock]')===null)
  assert.equal(await page.evaluate(()=>__composerFixture.calls.filter(call=>call.queue).map(call=>call.action.kind).join(',')),'edit,remove')
  await set({todos:[],goal:false,stats:false})
  assert.equal(await page.locator('[data-goal-bar]').count(),0)
  assert.equal(await page.locator('[data-composer-stats]').count(),0)
  assert.equal(await page.locator('[data-composer-footer]').isVisible(),false)
  // Icon controls do not expose model names or metrics until opened.
  assert.equal(await page.locator('[data-xh-model-control="model"]').innerText(),'')
  assert.equal(await page.locator('[data-xh-model-control="effort"]').count(),0)
  await page.setViewportSize({width:640,height:780})
  await set({stats:true,dark:false})
  await page.locator('[data-composer-card]').screenshot({path:resolve(output,`${engine}-minimal-card.png`),animations:'disabled'})
  await set({dark:true})
  await page.locator('[data-composer-card]').screenshot({path:resolve(output,`${engine}-minimal-dark-card.png`),animations:'disabled'})
  await set({dark:false})
  // Model/effort/context menus remain reachable above the action row at 320px.
  await page.setViewportSize({width:320,height:780})
  await page.locator('[data-xh-model-control="model"]').click()
  const menu=page.getByRole('menu').filter({hasText:'Model'})
  await menu.waitFor()
  const menuBox=await menu.boundingBox()
  assert.ok(menuBox.x>=0&&menuBox.x+menuBox.width<=320&&menuBox.y>=0,JSON.stringify(menuBox))
  await page.getByRole('menuitem',{name:/上下文容量/}).click()
  const contextBox=await page.getByRole('dialog').boundingBox()
  assert.ok(contextBox.x>=0&&contextBox.x+contextBox.width<=320&&contextBox.y>=0,JSON.stringify(contextBox))
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.locator('[data-xh-model-control="model"]').click()
  await page.getByRole('menuitem',{name:'Effort Default',exact:true}).click()
  await page.getByRole('menuitemradio',{name:'High',exact:true}).waitFor()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.getByRole('button',{name:/25% of context used/}).click()
  await page.getByRole('dialog').waitFor()
  const usageBox=await page.getByRole('dialog').boundingBox()
  assert.ok(usageBox.x>=0&&usageBox.x+usageBox.width<=320&&usageBox.y>=0,JSON.stringify(usageBox))
  await page.keyboard.press('Escape')
  // Hero/active transition preserves the real textarea and draft.
  await input.fill('Hero transition draft')
  await input.evaluate(el=>{el.dataset.identity='original'})
  await set({hero:true})
  assert.equal(await page.locator('[data-composer-layout="hero"]').count(),1)
  assert.equal(await page.locator('[data-xh-model-control="effort"]').count(),1)
  assert.match(await page.locator('[data-xh-model-control="model"]').innerText(),/qwen/)
  assert.equal(await input.getAttribute('data-identity'),'original')
  await set({hero:false})
  assert.equal(await page.locator('[data-composer-layout="compact"]').count(),1)
  assert.equal(await page.locator('[data-xh-model-control="effort"]').count(),0)
  assert.equal(await page.locator('[data-xh-model-control="model"]').innerText(),'')
  assert.equal(await input.getAttribute('data-identity'),'original')
  assert.equal(await input.inputValue(),'Hero transition draft')
  assert.deepEqual(errors,[])
  writeFileSync(resolve(output,`${engine}-geometry.json`),JSON.stringify(readings,null,2)+'\n')
  console.log(`${engine}: 20 light/dark viewport cases; long names; native picker; Stop/Queue/Send; draft/caret; Goal edit/budget; Todo; keyboard stats; menus; hero continuity passed`)
} finally {await browser.close();await new Promise(resolve=>server.close(resolve))}
