// Actual DOM/IPC-shaped bridge A/B against the independent merged-master scripts.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import {scriptAsset} from './fixtures/script-asset-test.mjs'
const require=createRequire(resolve(process.env.UI_TEST_DEPS ?? '.', 'package.json'))
const {chromium,webkit}=require('playwright')
const engine=process.env.UI_TEST_BROWSER ?? 'chromium'
assert.ok(['chromium','webkit'].includes(engine))
const browser=await ({chromium,webkit}[engine]).launch({headless:true})
// These are two independent producer chains, not one serialized IPC protocol.
// Keep every mandatory command and its parameters in causal order; only the
// relative first-frame/status interleaving is intentionally unconstrained.
function causalObservation(row) {
  const startup=[],updater=[],checks=[];
  for(const [index,call] of row.commands.entries()) {
    assert.ok(Array.isArray(call)&&call.length===2,'complete IPC command/arguments pair');
    const [command,args]=call;
    if(command==='desktop_report_startup_phase')startup.push(call);
    else if(['desktop_status','desktop_update_status','desktop_download_update','desktop_install_update'].includes(command))updater.push(call);
    else if(command==='desktop_check_update'){
      assert.equal(args,null,'silent check uses no additional arguments');checks.push(index);
    } else assert.fail('unexpected desktop command '+command);
  }
  assert.deepEqual(startup,[
    ['desktop_report_startup_phase',{phase:'frontend_hydrated'}],
    ['desktop_report_startup_phase',{phase:'first_frame'}],
  ],'hydrated→first-frame exactly once, with exact phase parameters');
  assert.deepEqual(updater,[
    ['desktop_status',null],['desktop_update_status',null],
    ['desktop_download_update',null],['desktop_install_update',{confirmStop:true}],
  ],'status→restore→download→confirmed install exactly once, with exact parameters');
  const at=(command,phase)=>row.commands.findIndex(call=>call[0]===command&&(phase===undefined||call[1]?.phase===phase));
  assert.ok(at('desktop_report_startup_phase','frontend_hydrated')<at('desktop_status'),'fixture loads startup before updater boot');
  assert.ok(at('desktop_report_startup_phase','first_frame')<at('desktop_download_update'),'UI action waits for the first-frame milestone');
  // The original fixture excluded background timer checks from equality. Do
  // not hide them: verify the only legal optional command, its arguments and
  // its window after restoration/before a durable download instead.
  for(const index of checks)assert.ok(at('desktop_update_status')<index&&index<at('desktop_download_update'),'silent checks may not precede restore or replace a durable download/install');
  assert.deepEqual(row.phases,['frontend_hydrated','first_frame']);
  assert.equal(row.hidden,false);
  assert.equal(row.update,'更新完成，正在重启…');
  return {startup,updater,phases:row.phases,hidden:row.hidden,update:row.update};
}
const startupFirst={commands:[
  ['desktop_report_startup_phase',{phase:'frontend_hydrated'}],
  ['desktop_report_startup_phase',{phase:'first_frame'}],
  ['desktop_status',null],['desktop_update_status',null],
  ['desktop_download_update',null],['desktop_install_update',{confirmStop:true}],
],phases:['frontend_hydrated','first_frame'],hidden:false,update:'更新完成，正在重启…'};
const updaterFirst=structuredClone(startupFirst);
updaterFirst.commands.splice(3,0,...updaterFirst.commands.splice(1,1));
assert.deepEqual(causalObservation(startupFirst),causalObservation(updaterFirst),'both legal independent-chain interleavings are equivalent');
const withCheck=structuredClone(updaterFirst);withCheck.commands.splice(4,0,['desktop_check_update',null]);
assert.deepEqual(causalObservation(withCheck),causalObservation(updaterFirst),'legal timed check remains checked, not a new ordering requirement');
let negativeCases=0;
function rejectTrace(name,mutate) {
  const bad=structuredClone(updaterFirst);mutate(bad);
  assert.throws(()=>causalObservation(bad),assert.AssertionError,name);negativeCases++;
}
rejectTrace('reversed startup phases',row=>{[row.commands[0],row.commands[3]]=[row.commands[3],row.commands[0]]});
rejectTrace('restore before status',row=>{[row.commands[1],row.commands[2]]=[row.commands[2],row.commands[1]]});
rejectTrace('install before download',row=>{[row.commands[4],row.commands[5]]=[row.commands[5],row.commands[4]]});
rejectTrace('unconfirmed install',row=>{row.commands[5][1].confirmStop=false});
rejectTrace('unexpected IPC argument',row=>{row.commands[4][1]={unexpected:true}});
rejectTrace('duplicate mandatory operation',row=>row.commands.push(['desktop_download_update',null]));
rejectTrace('unknown command',row=>row.commands.push(['desktop_unknown',null]));
rejectTrace('download before first-frame wait',row=>{[row.commands[3],row.commands[4]]=[row.commands[4],row.commands[3]]});
rejectTrace('silent check before restore',row=>row.commands.splice(1,0,['desktop_check_update',null]));
rejectTrace('silent check replaces verified download',row=>row.commands.push(['desktop_check_update',null]));
rejectTrace('silent check wrong arguments',row=>row.commands.splice(4,0,['desktop_check_update',{confirmStop:true}]));
rejectTrace('wrong recorded phase order',row=>row.phases.reverse());
rejectTrace('wrong page lifecycle state',row=>row.hidden=true);
rejectTrace('wrong installed UI state',row=>row.update='still downloading');
const rounds=Number(process.env.UI_SCRIPT_ASSET_ROUNDS??3);
assert.ok(Number.isSafeInteger(rounds)&&rounds>=2&&rounds<=10,'multiple bounded scheduling rounds');
const paths=['desktop-startup.js','desktop-titlebar.js','desktop-updater.js','logo-motion.js'];
const assets=Object.fromEntries(['legacy','source'].map(impl=>[impl,Object.fromEntries(paths.map(path=>[path,scriptAsset(path,impl)]))]));
let cases=0,baseline;
const traces=[];
try {
  for(let round=0;round<rounds;round++) for(const schedule of ['startup-first','updater-first','natural']) {
  const observed=[];
  for(const impl of ['legacy','source']) {
    const page=await browser.newPage({viewport:{width:1254,height:768}}),errors=[]
    page.on('pageerror',error=>errors.push(error.message))
    await page.setContent('<div id="root"><p>hydrated app fixture</p></div>')
    await page.evaluate(()=>{
      window.__calls=[]; window.__phases=[]; window.__state={seq:1,phase:'available',version:'9.9.9',downloaded:0,total:null};
      window.__TAURI__={core:{invoke:async(command,args)=>{
        window.__calls.push([command,args]);
        if(command==='desktop_status')return {updaterConfigured:true};
        if(command==='desktop_report_startup_phase'){window.__phases.push(args.phase);return null;}
        if(command==='desktop_download_update')window.__state={seq:2,phase:'downloaded',version:'9.9.9',notes:'<img onerror=alert(1)>'};
        if(command==='desktop_install_update')window.__state={seq:3,phase:'installed'};
        return window.__state;
      }},event:{listen:async(_name,listener)=>{window.__emit=listener;return ()=>{window.__unlistened=true}}}};
    })
    if(schedule==='startup-first') {
      await page.addScriptTag({content:assets[impl]['desktop-startup.js']});
      await page.waitForFunction(()=>window.__phases.includes('first_frame'));
      for(const path of paths.slice(1))await page.addScriptTag({content:assets[impl][path]});
    } else if(schedule==='updater-first') {
      // One browser task preserves the actual scripts and real native RAF:
      // updater promise microtasks restore status before the two paint frames.
      await page.addScriptTag({content:paths.map(path=>assets[impl][path]).join('\n;\n')});
    } else {
      // Preserve the original separate script tags / unconstrained scheduling.
      for(const path of paths)await page.addScriptTag({content:assets[impl][path]});
    }
    const host=page.locator('#xharness-desktop-updater'),toggle=host.locator('.toggle'),panel=host.locator('.panel')
    await host.waitFor({state:'visible'});await page.waitForFunction(()=>window.__phases.includes('first_frame'))
    assert.equal(await panel.isVisible(),false)
    await toggle.click(); assert.equal(await panel.isVisible(),true)
    assert.equal(await host.locator('.action').textContent(),'下载更新')
    await host.locator('.action').click(); await page.waitForFunction(()=>window.__state.phase==='downloaded')
    assert.equal(await host.locator('.notes').textContent(),'<img onerror=alert(1)>')
    assert.equal(await host.locator('.notes img').count(),0)
    await host.locator('.action').click();assert.equal(await host.locator('.confirm').isVisible(),true)
    await toggle.press('Escape');assert.equal(await panel.isVisible(),false)
    assert.equal(await page.evaluate(()=>window.__calls.some(row=>row[0]==='desktop_install_update')),false)
    await toggle.click();await host.locator('.action').click();await host.locator('.action').click()
    await page.waitForFunction(()=>window.__state.phase==='installed')
    await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')))
    assert.equal(await page.evaluate(()=>window.__unlistened),true)
    assert.deepEqual(errors,[])
    const observation=await page.evaluate(()=>({
      commands:window.__calls.map(row=>[row[0],row[1]??null]),
      phases:window.__phases,hidden:document.documentElement.hasAttribute('data-xh-page-hidden'),
      update:document.querySelector('#xharness-desktop-updater').shadowRoot.querySelector('.text').textContent,
    }));
    const semantic=causalObservation(observation);
    const firstFrame=observation.commands.findIndex(call=>call[0]==='desktop_report_startup_phase'&&call[1]?.phase==='first_frame');
    const status=observation.commands.findIndex(call=>call[0]==='desktop_status');
    const restored=observation.commands.findIndex(call=>call[0]==='desktop_update_status');
    if(schedule==='startup-first')assert.ok(firstFrame<status,'actively cover startup-first ordering with real browser frames');
    if(schedule==='updater-first')assert.ok(restored<firstFrame,'actively cover updater-first ordering with real promise/paint scheduling');
    if(baseline===undefined)baseline=semantic;
    else assert.deepEqual(semantic,baseline,'same complete per-chain protocol/UI across rounds and legal interleavings');
    observed.push(semantic);cases++;
    traces.push({round,schedule,impl,commands:observation.commands});
    await page.close()
  }
  assert.deepEqual(observed[1],observed[0],'frozen/source causal chains and all terminal observations match');
  }
  console.log(JSON.stringify({engine,rounds,cases,negativeCases,traces}));
  console.log(`PASS ${engine}: ${cases} latest-master/source actual DOM A/B cases; both controlled legal interleavings plus natural scheduling, exact phase/IPC chain arguments, confirmation/lifecycle and ${negativeCases} bad-order/boundary rejections`);
}finally{await browser.close()}
