// Exercise the actual source GoalDock, Menu and Modal in an isolated preview.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdirSync} from 'node:fs'
import {resolve} from 'node:path'
import {createGoalPreview} from '../preview-goal-controls.mjs'
export async function runCompactGoalBrowser(){
 const require=createRequire(resolve(process.env.UI_TEST_DEPS??'/tmp/ui-tests','package.json'))
 const engine=process.env.UI_TEST_BROWSER??'chromium'
 const server=createGoalPreview();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const address=server.address();assert.ok(address&&typeof address==='object')
 const origin=`http://127.0.0.1:${address.port}`
 const browser=await require('playwright')[engine].launch({headless:true,...(process.env.UI_TEST_EXECUTABLE?{executablePath:process.env.UI_TEST_EXECUTABLE}:{})})
 try{
  const page=await browser.newPage({viewport:{width:1100,height:720}}),errors=[],requests=[]
  page.on('pageerror',e=>errors.push(e.message))
  page.on('request',r=>requests.push(r.url()))
  page.setDefaultTimeout(8000)
  const button=name=>page.getByRole('button',{name,exact:true})
  const menu=()=>button('更多目标操作').click()
  const render=(state='running',phase='active',id='goal-test')=>page.evaluate(([s,p,id])=>renderGoal(s,p,id),[state,phase,id])
  const lastCall=()=>page.evaluate(()=>goalPreview.calls.at(-1))
  const evidence=resolve(process.env.UI_TEST_OUTPUT??'dist/goal-ui',process.env.UI_TEST_IMPL??'source');mkdirSync(evidence,{recursive:true})
  await page.goto(origin)
  await button('暂停目标').waitFor()
  assert.equal(await page.getByRole('menu').count(),0)
  assert.ok((await page.locator('[data-goal-bar] > div').first().getAttribute('title')).includes('artifact: tests/login.test.ts'))
  assert.equal(await button('清除目标').count(),0)
  await page.screenshot({path:resolve(evidence,engine+'-desktop.png')})
  await button('暂停目标').click();await button('恢复目标').waitFor();assert.equal((await lastCall()).name,'pause')
  await button('恢复目标').click();await button('暂停目标').waitFor();assert.equal((await lastCall()).name,'resume')
  await menu()
  assert.deepEqual(await page.getByRole('menuitem').allTextContents(),['编辑目标','标记完成','清除目标'])
  await page.screenshot({path:resolve(evidence,engine+'-menu.png')})
  await button('更多目标操作').press('Escape');assert.equal(await page.getByRole('menu').count(),0)
  assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'更多目标操作')
  await menu();await page.getByRole('textbox',{name:'Preview message'}).click();assert.equal(await page.getByRole('menu').count(),0)
  const original=await page.evaluate(()=>({id:goalPreview.projection.goal.id,objective:goalPreview.projection.goal.objective}));
  await page.getByRole('button',{name:/^查看目标详情:/}).click();await page.getByRole('dialog',{name:'目标详情',exact:true}).waitFor();
  await page.getByRole('dialog').getByRole('button',{name:'编辑目标',exact:true}).click();
  const editor=page.getByRole('textbox',{name:'目标内容'});
  await editor.fill('  新目标：回归通过\n不要发布  ');await editor.press('Enter');
  assert.equal((await page.evaluate(()=>goalPreview.calls.at(-1)))?.name,'resume','plain Enter must not save');
  await page.getByRole('dialog').getByRole('button',{name:'保存目标',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'hidden'});
  await button('恢复目标').waitFor();assert.deepEqual(await lastCall(),{name:'edit',args:['新目标：回归通过\n不要发布',original]})
  await render('running')
  const statistics=page.getByLabel('累计自动轮数',{exact:true})
  assert.equal(await statistics.textContent(),'12 轮')
  assert.equal(await statistics.evaluate(e=>e.tagName),'SPAN')
  assert.equal(await button('调整轮数预算').count(),0)
  await render('awaiting_confirmation')
  assert.equal(await button('暂停目标').count(),0)
  await button('确认完成').click();await button('重新开启').waitFor()
  assert.equal((await lastCall()).name,'complete');assert.equal(await button('确认完成').count(),0)
  await button('重新开启').click();await button('暂停目标').waitFor()
  await menu();await page.getByRole('menuitem',{name:'标记完成',exact:true}).click();await button('重新开启').waitFor()
  await render('blocked','blocked');await button('恢复目标').click();await button('暂停目标').waitFor()
  await render('disabled');assert.equal(await button('暂停目标').count(),0);await button('启用自动推进').click();await button('暂停目标').waitFor()
  // Transient failures stay visible and retryable. A pending call is locked once.
  await page.evaluate(()=>{goalPreview.fail=true})
  await button('暂停目标').click();await page.getByRole('status').getByText('connection lost',{exact:false}).waitFor()
  assert.equal(await button('暂停目标').isEnabled(),true)
  await page.evaluate(()=>{goalPreview.fail=false});await button('暂停目标').click();await button('恢复目标').waitFor()
  assert.equal(await page.getByRole('status').count(),0)
  await page.evaluate(()=>{goalPreview.hold=true})
  await button('恢复目标').click();assert.equal(await button('恢复目标').isEnabled(),false)
  await render('paused','paused','replacement')
  await page.waitForFunction(()=>!document.querySelector('button[aria-label="恢复目标"]').disabled)
  await page.evaluate(()=>{goalPreview.hold=false;goalPreview.fail=true;goalPreview.pendingResolve()})
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
  assert.equal(await button('恢复目标').isEnabled(),true);assert.equal(await page.getByRole('status').count(),0)
  await page.evaluate(()=>{goalPreview.fail=false})
  // Clear is never a single accidental click; failure keeps the confirmation.
  await menu();await page.getByRole('menuitem',{name:'清除目标',exact:true}).click()
  const clearDialog=page.getByRole('dialog',{name:'清除目标？'}),countBefore=await page.evaluate(()=>goalPreview.calls.length)
  await clearDialog.getByRole('button',{name:'取消',exact:true}).click()
  assert.equal(await page.evaluate(()=>goalPreview.calls.length),countBefore)
  await menu();await page.getByRole('menuitem',{name:'清除目标',exact:true}).click()
  await page.evaluate(()=>{goalPreview.fail=true})
  await clearDialog.getByRole('button',{name:'清除目标',exact:true}).click();await clearDialog.getByRole('alert').waitFor()
  await page.evaluate(()=>{goalPreview.fail=false})
  await clearDialog.getByRole('button',{name:'清除目标',exact:true}).click();await page.locator('[data-goal-bar]').waitFor({state:'hidden'})
  // An open confirmation is scoped to its Goal, not the newly selected card.
  await render();await menu();await page.getByRole('menuitem',{name:'清除目标',exact:true}).click()
  await render('running','active','different');assert.equal(await page.getByRole('dialog').count(),0)
  for(const width of [960,375,320]){
   await page.setViewportSize({width,height:720})
   for(const [state,phase]of [['running','active'],['paused','paused'],['blocked','blocked'],['awaiting_confirmation','active'],['disabled','active'],['network_backoff','active'],['complete','complete']]){
    await render(state,phase,'layout-'+state)
    assert.equal(await page.locator('[data-goal-bar]').count(),1)
    assert.equal(await page.locator('details').count(),0)
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${state} fits ${width}px`)
   }
   await render();await page.evaluate(()=>{renderGoal('running','active','long-goal','很长的目标，不应把操作挤出屏幕。'.repeat(30))})
   await menu()
   const rect=await page.getByRole('menu').boundingBox();assert.ok(rect.x>=0&&rect.x+rect.width<=width+1)
   if(width===375)await page.screenshot({path:resolve(evidence,engine+'-mobile.png')})
   await button('更多目标操作').press('Escape')
   assert.ok((await page.getByRole('button',{name:/^查看目标详情:/}).boundingBox()).height<=51,'long dock preview must stay within two lines, including native Safari buttons');
   await page.getByRole('button',{name:/^查看目标详情:/}).click();
   const details=page.getByRole('dialog',{name:'目标详情',exact:true}),full=details.locator('[data-goal-description]');
   assert.ok((await full.textContent()).includes('很长的目标，不应把操作挤出屏幕。'.repeat(30)));
   let rectDetails=await details.boundingBox();assert.ok(rectDetails.x>=0&&rectDetails.x+rectDetails.width<=width+1);
   await details.getByRole('button',{name:'编辑目标',exact:true}).click();
   const editorDialog=page.getByRole('dialog',{name:'编辑目标',exact:true}),area=editorDialog.getByRole('textbox',{name:'目标内容'});
   assert.equal(await area.evaluate(el=>el.tagName),'TEXTAREA');assert.ok((await area.boundingBox()).height>=200);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   assert.ok((await editorDialog.boundingBox()).height<=720);
   await page.screenshot({path:resolve(evidence,`${engine}-goal-editor-${width}.png`)});
   await area.press('Escape');await editorDialog.waitFor({state:'hidden'});
   await menu();await page.getByRole('menuitem',{name:'清除目标',exact:true}).click()
   const modal=await page.getByRole('dialog').boundingBox();assert.ok(modal.x>=0&&modal.x+modal.width<=width+1)
   await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click()
  }
  await page.setViewportSize({width:1100,height:720})
  await render();await page.evaluate(()=>{goalPreview.projection.execution.roundsStarted=257;goalPreview.projection.execution.maxGoalRounds=1});await button('Light').click();
  assert.equal(await page.getByLabel('累计自动轮数',{exact:true}).textContent(),'257 轮');await page.screenshot({path:resolve(evidence,engine+'-light.png')})
  await button('English').click();await button('Pause goal').waitFor();await button('More goal actions').click()
  assert.deepEqual(await page.getByRole('menuitem').allTextContents(),['Edit goal','Mark complete','Clear goal'])
  await page.getByRole('menuitem',{name:'Clear goal',exact:true}).click()
  await page.getByRole('dialog',{name:'Clear goal?'}).waitFor()
  await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click()
  await render('absent');assert.equal(await page.locator('[data-goal-bar]').count(),0)
  assert.equal(await page.locator('[data-goal-create]').count(),0)
  assert.deepEqual(errors.filter(e=>e!=='goal preview: Host boot intentionally disabled'),[])
  assert.ok(requests.every(url=>url.startsWith(origin+'/')),'preview never contacts Host or external services')
  console.log(`${engine}: compact Goal controls, menu dismissal/focus, edit, read-only round statistics, completion/reopen, legacy enable, confirmation, retry, stale receipt, 320/375/960px, light/dark and locales passed`)
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
}
