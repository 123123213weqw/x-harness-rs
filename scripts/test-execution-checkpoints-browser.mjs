// Actual shipped React, primitives, workspace owner and product flow; only the
// host services/slot harness are fixtures. No running App or user data is used.
import { verifyConversationArtifact, exposeConversation, legacyConversation } from './conversation-artifact-test.mjs'
import { installOwnedViewPlatform } from './fixtures/owned-view-platform-browser.mjs'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const implementation = process.env.UI_TEST_IMPL ?? 'source'
assert.ok(['source', 'native', 'legacy', 'frozen'].includes(implementation), 'known feature implementation')
const frozen = implementation === 'legacy' || implementation === 'frozen'
const dist = resolve(root, frozen ? 'ui/reference/master-a613970' : 'ui/dist')
const shippedConversation = frozen ? legacyConversation().toString() : verifyConversationArtifact()
const require = createRequire(resolve(process.env.UI_TEST_DEPS ?? '/tmp/ui-tests', 'package.json'))
const engines = require('playwright')
const engine = process.env.UI_TEST_BROWSER ?? 'chromium'
const browser = await engines[engine].launch({ headless: true,
  ...(process.env.UI_TEST_EXECUTABLE ? { executablePath: process.env.UI_TEST_EXECUTABLE } : {}) })
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.setDefaultTimeout(8000)
  await installOwnedViewPlatform(page, frozen ? 'legacy' : 'source')
  await page.evaluate(() => { document.getElementById('root').replaceChildren(); window.registrations = {}; window.__ModuleLoader__ = { load: reg => { registrations[reg.id] = reg } } })
  const plugins = readdirSync(resolve(dist,'plugins/@xharness'));
  for (const name of plugins) {
    const file = resolve(dist,'plugins/@xharness',name,'client.js');
    let source=readFileSync(file,'utf8');
    if(name==='dsh-client-ui-conversation') {
      assert.equal(source, shippedConversation, 'actual selected fresh/immutable Conversation factory')
      source=exposeConversation(shippedConversation,["XhCheckpointView", "xhCheckpointDefinition"]);
    }
    await page.addScriptTag({content:source});
  }
  await page.evaluate(() => {
    const cache={};
    function load(id) {
      if(staticModules[id]) return staticModules[id];
      const name=id.endsWith('/client')?id.slice(0,-7):id;
      if(cache[name])return cache[name];
      if(!registrations[name])throw Error('missing '+id);
      return cache[name]=registrations[name].factory(load);
    }
    const React=staticModules.react,DOM=staticModules['react-dom'];
    const module=load('@xharness/dsh-client-ui-conversation/client');
    window.module=module;
    const def=module.xhCheckpointDefinition;
    const Runtime=load('@xharness/dsh-client-runtime/client');
    const registry={entries:()=>[def],fallbackEntry:()=>undefined};
    const views={entries:()=>[{target:'chat',create:()=>{let nodes=new Map();return {empty:[],replace:x=>{nodes=new Map(x.nodes.map(n=>[n.key,n]));return [...nodes.values()]},apply:x=>{for(const n of x.upserts)nodes.set(n.key,n);return [...nodes.values()]}}}}]};
    const events=[{seq:0,time:1,type:'turn/start',data:{turn:0}},{seq:1,time:1,type:'run/checkpoint',data:{turn:0,notice:{kind:'issued',message:'执行检查点'}}},{seq:2,time:1,type:'turn/end',data:{turn:0,reason:{kind:'max-steps'}}}];
    const assembler=new Runtime.ConversationNodeAssembler(registry,views);
    for(const event of events){assembler.append({event});assembler.flush();}
    const live=JSON.stringify(assembler.snapshot('chat'));
    assembler.replaceWindow(events.map(event=>({event})),false);assembler.flush();
    if(JSON.stringify(assembler.snapshot('chat'))!==live)throw Error('live/reload node mismatch');
    assembler.replaceWindow(events.slice(1).map(event=>({event})),true);assembler.flush();
    assembler.prepend([{event:events[0]}],false);assembler.flush();
    if(JSON.stringify(assembler.snapshot('chat'))!==live)throw Error('pagination node mismatch');
    if(assembler.snapshot('chat').length!==2)throw Error('missing notice nodes');
    const root=DOM.createRoot(document.getElementById('root'));
    const event={seq:10,time:1,type:'run/checkpoint',data:{turn:0,notice:{kind:'issued',message:'阶段 1：相同参数连续返回相同错误，请检查原因。'}}};
    function render(e){const state=def.start({}, {event:e});DOM.flushSync(()=>root.render(React.createElement(module.XhCheckpointView,{node:{data:{...state,noticeKind:state.kind}}})));}
    window.renderCheckpoint=render;window.fixtureEvent=event;render(event);
  });
  await page.getByText('执行检查点',{exact:true}).click();
  await page.getByText('阶段 1：相同参数连续返回相同错误，请检查原因。',{exact:true}).waitFor();
  await page.evaluate(()=>renderCheckpoint(JSON.parse(JSON.stringify(fixtureEvent))));
  assert.equal(await page.locator('details').count(),1);
  await page.evaluate(()=>renderCheckpoint({...fixtureEvent,type:'turn/end',data:{turn:0,reason:{kind:'max-steps'}}}));
  await page.getByText('执行已停止：步骤硬上限',{exact:true}).waitFor();
  assert.equal(await page.locator('details').getAttribute('open'),'');
  await page.setViewportSize({width:375,height:700});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const evidence=resolve(root,'dist/execution-checkpoint-ui');mkdirSync(evidence,{recursive:true});
  await page.screenshot({path:resolve(evidence,engine+'-'+implementation+'.png')});
  assert.deepEqual(errors.filter(e=>e!=='owned feature fixture: stop Host boot'),[]);
  console.log(engine+'/'+implementation+': shipped checkpoint component expand/collapse, restored notice, visible hard limit and narrow layout passed');
} finally {await browser.close()}
