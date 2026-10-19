/** Isolated actual Swarm component + source platform; synthetic RPC, no paid models. */
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import {once} from 'node:events'
import {createSwarmPreview} from './preview-swarm.mjs'
const require=createRequire(resolve(process.env.UI_TEST_DEPS??'/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps','package.json'))
const {chromium,webkit}=require('playwright'),engine=process.env.UI_TEST_BROWSER??'chromium'
const server=createSwarmPreview().listen(0,'127.0.0.1');await once(server,'listening')
const browser=await({chromium,webkit}[engine]).launch({headless:true})
try{
 const page=await browser.newPage({viewport:{width:1487,height:1058}}),errors=[]
 page.on('pageerror',error=>{if(!error.message.includes('Host boot intentionally disabled'))errors.push(error.message)})
 await page.goto('http://127.0.0.1:'+server.address().port)
 const title=name=>page.getByRole('heading',{name,exact:true})
 await title('XHarness reliability').waitFor()
 await page.getByRole('button',{name:'Pause membership',exact:true}).click()
 await page.getByRole('button',{name:'Resume membership',exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>fixture.calls.filter(c=>c.payload.command.action==='set_status').length),1)
 assert.equal(await page.getByText('Running',{exact:true}).count(),1,'worker still running; metadata pause is not runtime cancel')
 await page.getByRole('button',{name:'Resume membership',exact:true}).click()
 await page.getByRole('button',{name:'Pause membership',exact:true}).waitFor()
 // Closing the rail route preserves the mounted conversation and unsent draft.
 await page.getByRole('textbox',{name:'Preview message'}).fill('Keep my unsent draft')
 await page.getByRole('button',{name:'Back to chat',exact:true}).click()
 await title('XHarness reliability').waitFor({state:'detached'})
 assert.equal(await page.getByRole('textbox',{name:'Preview message'}).inputValue(),'Keep my unsent draft')
 const before=await page.evaluate(()=>fixture.calls.length)
 await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>fixture.calls.length),before,'closed Swarm does not poll')
 await page.getByRole('button',{name:'Swarm / XHarness reliability',exact:true}).click();await title('XHarness reliability').waitFor()
 assert.equal(await page.getByRole('textbox',{name:'Preview message'}).inputValue(),'Keep my unsent draft')
 await page.getByRole('button',{name:'Theo Waiting Regression evidence',exact:true}).click()
 await title('XHarness reliability').waitFor({state:'detached'});assert.equal(await page.evaluate(()=>fixture.opened),'theo')
 await page.getByRole('button',{name:'Swarm / XHarness reliability',exact:true}).click();await title('XHarness reliability').waitFor()
 // Lost acknowledgement: no automatic duplicate create; writes remain blocked until explicit refresh.
 await page.getByRole('button',{name:'New',exact:true}).click();await title('New team').waitFor()
 await page.getByRole('textbox',{name:'Objective',exact:true}).fill('New durable team')
 await page.evaluate(()=>fixture.failAfterCommit=true)
 await page.getByRole('button',{name:'Create team',exact:true}).click()
 await page.getByRole('alert').waitFor();assert.equal(await page.getByRole('button',{name:'Create team',exact:true}).isDisabled(),true)
 assert.equal(await page.evaluate(()=>fixture.calls.filter(c=>c.payload.command.action==='create').length),1)
 await page.getByRole('button',{name:'Refresh team',exact:true}).click();await page.getByRole('alert').waitFor({state:'detached'})
 await page.getByRole('button',{name:'Cancel',exact:true}).click()
 await page.getByRole('combobox',{name:'Saved teams',exact:true}).selectOption('fixture-team-1');await title('New durable team').waitFor()
 await page.getByText('Link an existing worker',{exact:true}).click()
 await page.getByRole('combobox',{name:'Worker to link',exact:true}).selectOption('jules')
 await page.getByRole('button',{name:'Link worker',exact:true}).click()
 await page.getByRole('button',{name:'Jules Waiting Existing worker assignment',exact:true}).waitFor()
 // Scope change selects that conversation's team only; viewing never creates a team.
 await page.evaluate(()=>{fixture.deferOwner='owner';fixture.refresh()});await page.waitForFunction(()=>typeof fixture.release==='function')
 await page.evaluate(()=>fixture.setCurrent('other'));await title('Keep your team together').waitFor()
 await page.evaluate(()=>fixture.release());await page.waitForTimeout(50);assert.equal(await title('XHarness reliability').count(),0,'late read cannot restore the previous owner team')
 assert.equal(await page.locator('.xhswarm-person').count(),0)
 assert.equal(await page.evaluate(()=>fixture.calls.filter(c=>c.payload.command.action==='create').length),1)
 await page.evaluate(()=>fixture.setCurrent('owner'));await title('XHarness reliability').waitFor()
 // A docked workspace can narrow the center without narrowing the window.
 await page.locator('.fixture-swarm-container').evaluate(node=>node.style.width='600px')
 await page.getByRole('button',{name:'Team',exact:true}).waitFor({state:'visible'})
 await page.locator('.fixture-swarm-container').evaluate(node=>node.style.width='')
 await page.setViewportSize({width:390,height:844})
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
 await page.getByRole('button',{name:'Team',exact:true}).click();await page.getByRole('complementary',{name:'Team',exact:true}).waitFor({state:'visible'})
 const rail=await page.locator('.xhswarm-rail').boundingBox(),header=await page.locator('.xhswarm-header').boundingBox();assert.ok(rail.width>=250&&rail.width<=270,'compact rail must retain usable width');assert.ok(rail.y>=header.y+header.height-1,'compact rail must not cover its toggle/header')
 await page.getByRole('button',{name:'New',exact:true}).press('Escape');await page.getByRole('complementary',{name:'Team',exact:true}).waitFor({state:'hidden'})
 assert.equal(await page.getByRole('textbox',{name:'Preview message'}).isVisible(),true)
 const allowed=['list','inspect','create','set_status','attach_member'];assert.equal(await page.evaluate(allowed=>fixture.calls.every(c=>c.endpoint==='swarm/manage'&&allowed.includes(c.payload.command.action)),allowed),true)
 assert.deepEqual(errors,[])
 console.log(JSON.stringify({engine,actualComponent:true,metadataPause:true,conversationPreserved:true,workerNavigation:true,lostAckNoDuplicate:true,scopeIsolation:true,linkWorker:true,mobile:true,pageErrors:errors}))
}finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
