// Actual shipped React, primitives, workspace owner and product flow; only the
// host services/slot harness are fixtures. No running App or user data is used.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const dist = resolve(root, 'ui/dist')
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
  const assets = readdirSync(resolve(dist, 'assets'))
  const entry = assets.find(name => /^index-.*\.js$/.test(name))
  const css = assets.filter(name => name.endsWith('.css'))
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    const name = url.pathname.slice('/assets/'.length)
    if (url.pathname.startsWith('/assets/') && assets.includes(name)) {
      return route.fulfill({ body: readFileSync(resolve(dist, 'assets', name)),
        contentType: name.endsWith('.css') ? 'text/css' : 'application/javascript' })
    }
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head>
      ${css.map(name => `<link rel="stylesheet" href="/assets/${name}">`).join('')}
      <script>window.__ModuleLoader__={create: options => {window.staticModules=options.staticModules;throw Error('isolated fixture: stop host boot')}};</script>
      <script type="module" src="/assets/${entry}"></script></head><body><div id="root"></div></body></html>` })
    return route.abort()
  })
  let fail=false, delayed=null;const calls=[];
  await page.route('**/api/session.requestSnapshot',async route=>{
    const {payload}=route.request().postDataJSON();calls.push(payload);
    if(payload.seq===10)await new Promise(resolve=>delayed=resolve);
    const result=fail?{ok:false,error:{message:'audit unavailable'}}:{ok:true,value:{...payload,header:{provider:'test',model:'model',input:[{role:'user',content:'Full request '+payload.sessionId+' '+payload.seq}],system:'System restored',tools:[{name:'read',description:'restored tool'}],options:{}}}};
    await route.fulfill({contentType:'application/json',body:JSON.stringify({type:'server-response',rpcId:'test',result})}).catch(()=>{});
  });
  await page.goto('http://workspace-fixture.test/')
  await page.waitForFunction(() => window.staticModules)
  await page.evaluate(() => { document.getElementById('root').replaceChildren(); window.registrations = {}; window.__ModuleLoader__ = { load: reg => { registrations[reg.id] = reg } } })
  const source=readFileSync(resolve(dist,'plugins/@xlang/xharness-client-ui-context/client.js'),'utf8').replace('exports.apply = apply','exports.ContextView=ContextView;exports.HarnessView=HarnessView;exports.apply = apply');
  await page.addScriptTag({content:source});
  await page.evaluate(()=>{
    const React=staticModules.react,DOM=staticModules['react-dom'];
    const component=registrations['@xlang/xharness-client-ui-context'].factory(id=>staticModules[id]);
    const root=DOM.createRoot(document.getElementById('root'));let state;
    window.show=(seq,sessionId='a',view='context')=>{
      const requests=[seq].map(seq=>({seq,header:{options:{snapshotOnDemand:true,inputMessageCount:1}},turn:1,step:seq}));
      state={views:new Map([['xharness-context',{requests,compactions:[]} ]])};
      DOM.flushSync(()=>root.render(React.createElement(view==='context'?component.ContextView:component.HarnessView,{sessionId,useSession:selector=>selector(state)})));
    };
    window.showDiff=()=>{
      state={views:new Map([['xharness-context',{requests:[4,5,7].map(seq=>({seq,header:{options:{snapshotOnDemand:true}},turn:1,step:seq})),compactions:[{seq:6,summary:'compacted',beforeCount:2,afterCount:1}]}]])};
      DOM.flushSync(()=>root.render(React.createElement(component.ContextView,{sessionId:'diff',useSession:selector=>selector(state)})));
    };
    window.unmount=()=>DOM.flushSync(()=>root.render(null));show(1);
  });
  await page.getByText('Full request a 1',{exact:true}).waitFor();assert.equal(calls.length,1);
  await page.evaluate(()=>show(2,'a','harness'));
  await page.getByText('System restored',{exact:true}).first().waitFor();
  fail=true;await page.evaluate(()=>show(3));await page.getByRole('alert').waitFor();
  fail=false;await page.getByRole('button',{name:'重试',exact:true}).click();await page.getByText('Full request a 3',{exact:true}).waitFor();
  await page.evaluate(()=>show(10));
  await page.waitForFunction(()=>document.body.textContent.includes('正在按需'));
  while(!delayed)await new Promise(resolve=>setTimeout(resolve,10));
  await page.evaluate(()=>show(11,'b'));await page.getByText('Full request b 11',{exact:true}).waitFor();
  delayed();await page.waitForTimeout(100);assert.equal(await page.getByText('Full request a 10',{exact:true}).count(),0);
  for(let i=12;i<18;i++){await page.evaluate(i=>show(i,'b'),i);await page.getByText('Full request b '+i,{exact:true}).waitFor();}
  assert.equal(await page.getByText('Full request b 11',{exact:true}).count(),0);
  await page.evaluate(()=>showDiff());await page.getByText('Full request diff 7',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Diff',exact:true}).click();await page.getByText('Full request diff 5',{exact:true}).waitFor();
  assert.equal(calls.some(c=>c.sessionId==='diff'&&c.seq===4),false);
  await page.evaluate(()=>unmount());assert.equal(await page.locator('#root').textContent(),'');
  assert.deepEqual(errors.filter(e=>!e.includes('isolated fixture: stop host boot')),[]);
  console.log(engine+': on-demand Context/Harness hydration, retry, late response, switching sessions, bounded selection, unmount passed');
} finally {await browser.close()}
