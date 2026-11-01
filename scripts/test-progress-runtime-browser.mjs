// Actual shipped React, primitives, workspace owner and product flow; only the
// host services/slot harness are fixtures. No running App or user data is used.
import {installOwnedViewPlatform} from './fixtures/owned-view-platform-browser.mjs'
import {verifyArtifact} from './fixtures/shipped-source-values.mjs'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const impl=process.env.UI_TEST_IMPL??'artifact';assert.ok(['artifact','source','legacy'].includes(impl));
const root = fileURLToPath(new URL('../', import.meta.url))
const dist = resolve(process.env.UI_TEST_DIST??resolve(root,impl==='legacy'?'ui/reference/master-a613970':'ui/dist'))
const goalSource=readFileSync(resolve(dist,'plugins/@xharness/dsh-client-ui-goal/client.js'),'utf8')
if(impl!=='legacy')assert.equal(goalSource,verifyArtifact('@xharness/dsh-client-ui-goal'),'actual Goal artifact is strict-source fresh')
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
  await installOwnedViewPlatform(page,impl==='legacy'?'legacy':'source')
  await page.evaluate(() => { document.getElementById('root').replaceChildren(); window.registrations = {}; window.__ModuleLoader__ = { load: reg => { registrations[reg.id] = reg } } })
  const plugins = readdirSync(resolve(dist,'plugins/@xharness'));
  for (const name of plugins) {
    const file = resolve(dist,'plugins/@xharness',name,'client.js');
    let source=readFileSync(file,'utf8');
    // Every source selection probes the same source-fresh production factory;
    // frozen selection reads only the immutable latest-master baseline.
    if(name==='dsh-client-ui-goal')source=goalSource;
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
    const module=load('@xharness/dsh-client-ui-goal/client');
    const root=DOM.createRoot(document.getElementById('root'));

    window.renderProgress = (plan) => DOM.flushSync(()=>root.render(React.createElement(module.ProgressDock,{useProjection:name=>name==='taskPlan'?plan:null,t:key=>({'progress.title':'Progress','progress.completed':'Completed','progress.running':'In progress','progress.pending':'Pending'}[key]??key)})));
    Object.assign(document.body.style,{padding:'24px',margin:'0'});
    const style=document.documentElement.style;
    for (const [name,value] of Object.entries({'--dsw-specific-tip':'#f7f7f7','--dsw-alias-label-primary':'#222222','--dsw-alias-label-tertiary':'#777777','--dsw-alias-border-l1':'#dddddd','--dsh-composer-side-clearance':'0px','--dsh-composer-dock-inset':'0px'})) style.setProperty(name,value);
    renderProgress(null);
  });
  assert.equal(await page.locator('.xh-progress-card').count(),0);
  const plan={revision:1,items:[
    {id:'fix',title:'修复问题 · Implement fix',status:'completed'},
    {id:'test',title:'运行回归 · Run regression tests',status:'in_progress'},
    {id:'pr',title:'提交 PR · Submit pull request',status:'pending'},
  ]};
  await page.evaluate(plan=>renderProgress(plan),plan);
  await page.locator('.xh-progress-card').waitFor();
  assert.equal(await page.locator('.xh-progress-count').innerText(),'1/3');
  assert.deepEqual(await page.locator('[data-plan-item]').evaluateAll(nodes=>nodes.map(node=>node.dataset.planItem)),['fix','test','pr']);
  assert.match(await page.locator('[data-plan-status="completed"] .xh-progress-item').evaluate(node=>getComputedStyle(node).textDecorationLine),/line-through/);
  await page.locator('summary').focus();await page.keyboard.press('Enter');
  assert.equal(await page.locator('details').getAttribute('open'),null);
  await page.keyboard.press('Enter');
  assert.notEqual(await page.locator('details').getAttribute('open'),null);
  const output=resolve(process.env.UI_TEST_OUTPUT??resolve(root,'dist/progress-ui',engine));mkdirSync(output,{recursive:true});
  await page.locator('summary').blur();
  await page.locator('.xh-progress-card').screenshot({path:resolve(output,'progress-light.png')});
  // Long/untrusted titles stay literal, preserve order, and do not overflow a narrow viewport.
  plan.revision=2;plan.items.push({id:'parallel',title:'<img src=x onerror=alert(1)> '+ 'long-title-'.repeat(35),status:'in_progress'});
  await page.setViewportSize({width:400,height:720});
  await page.evaluate(plan=>renderProgress(plan),plan);
  assert.equal(await page.locator('.xh-progress-count').innerText(),'1/4');
  assert.equal(await page.locator('.xh-progress-card img').count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.evaluate(()=>{
    document.documentElement.style.setProperty('--dsw-specific-tip','#292929');
    document.documentElement.style.setProperty('--dsw-alias-label-primary','#eeeeee');
    document.documentElement.style.setProperty('--dsw-alias-label-tertiary','#aaaaaa');
    document.documentElement.style.setProperty('--dsw-alias-border-l1','#444444');
    document.body.style.background='#1d1d1d';
  });
  await page.locator('.xh-progress-card').screenshot({path:resolve(output,'progress-dark-narrow.png')});
  await page.evaluate(()=>renderProgress({revision:3,items:[]}));
  assert.equal(await page.locator('.xh-progress-card').count(),0);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({browser:engine,tests:['empty','progress-count','ordered-states','completed-style','keyboard-collapse','literal-title','parallel-items','narrow-layout','clear'],screenshots:output,passed:true}));
} finally { await browser.close(); }
