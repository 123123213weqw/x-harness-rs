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
  await page.goto('http://workspace-fixture.test/')
  await page.waitForFunction(() => window.staticModules)
  await page.evaluate(() => { document.getElementById('root').replaceChildren(); window.registrations = {}; window.__ModuleLoader__ = { load: reg => { registrations[reg.id] = reg } } })
  const plugins = readdirSync(resolve(dist,'plugins/@deepseek-ai'));
  for (const name of plugins) {
    const file = resolve(dist,'plugins/@deepseek-ai',name,'client.js');
    let source=readFileSync(file,'utf8');
    if(name==='dsh-client-ui-conversation') source=source.replace('exports.XHarnessMessageEditor =', 'exports.XhCheckpointView = XhCheckpointView; exports.xhCheckpointDefinition = xhCheckpointDefinition; exports.XHarnessMessageEditor =');
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
    const module=load('@deepseek-ai/dsh-client-ui-goal/client');
    const root=DOM.createRoot(document.getElementById('root'));
    window.calls=[];window.fail=false;window.pendingResolve=null;
    const action=name=>async()=>{calls.push(name);if(window.hold)await new Promise(resolve=>window.pendingResolve=resolve);if(window.fail)throw Error('connection lost');return {ok:true,value:{}}};
    window.renderGoal=(state='awaiting_confirmation',phase='active',id='goal-1')=>{
      const projection={goal:{id,revision:3,objective:'实现解析器并验证测试',phase,maxGoalRounds:5},roundsStarted:3,execution:{state,enabled:true,roundsStarted:3,maxGoalRounds:5,report:{summary:'测试通过，请确认',remaining:[],evidence:[{kind:'artifact',reference:'tests/result.txt'}]}}};
      DOM.flushSync(()=>root.render(React.createElement(module.GoalDock,{useProjection:()=>state==='absent'?null:projection,goalSessionId:id,onCreate:action('create'),onBudget:action('budget'),onComplete:action('complete'),onResume:action('resume'),onPause:action('pause'),onClear:action('clear'),onEdit:action('edit'),t:key=>key})));
    };
    renderGoal();
  });
  await page.getByText('等待你确认完成 · 3/5 轮',{exact:true}).waitFor();
  assert.equal(await page.locator('details').count(),0);
  assert.equal(await page.locator('[data-goal-bar] [data-goal-runtime]').count(),1);
  assert.ok(await page.locator('[data-goal-bar] > div').getAttribute('title').then(v=>v.includes('artifact: tests/result.txt')));
  await page.getByRole('button',{name:'确认完成',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>calls),['complete']);
  await page.evaluate(()=>{fail=true});
  await page.getByRole('button',{name:'继续',exact:true}).click();
  await page.getByRole('alert').getByText('connection lost').waitFor();
  assert.equal(await page.getByRole('button',{name:'确认完成',exact:true}).isEnabled(),true);
  await page.evaluate(()=>{fail=false;hold=true});
  await page.getByRole('button',{name:'确认完成',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'确认完成',exact:true}).isEnabled(),false);
  await page.evaluate(()=>renderGoal('awaiting_confirmation','active','goal-2'));
  await page.evaluate(()=>{hold=false;pendingResolve()});
  assert.equal(await page.getByRole('alert').count(),0);
  await page.evaluate(()=>renderGoal('complete','complete','goal-2'));
  await page.getByText('已完成 · 3/5 轮',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'确认完成',exact:true}).count(),0);
  await page.evaluate(()=>renderGoal('blocked','blocked'));
  await page.getByRole('button',{name:'action.resume',exact:true}).waitFor();
  await page.evaluate(()=>renderGoal('disabled','active'));
  await page.getByRole('button',{name:'启用自动推进',exact:true}).click();
  await page.getByRole('button',{name:'预算',exact:true}).click();
  await page.getByRole('spinbutton',{name:'轮数预算'}).fill('12');
  await page.getByRole('button',{name:'保存轮数预算',exact:true}).click();
  assert.equal(await page.evaluate(()=>calls.includes('budget')),true);
  // No goal remains hidden; completed goals stay in the original single card.
  await page.evaluate(()=>renderGoal('running','active','goal-wide'));
  const evidence=resolve(root,'dist/goal-ui');mkdirSync(evidence,{recursive:true});
  await page.screenshot({path:resolve(evidence,engine+'-desktop.png')});
  await page.setViewportSize({width:375,height:700});
  for(const state of ['running','blocked','awaiting_confirmation','disabled']) {
    await page.evaluate(state=>renderGoal(state,state==='blocked'?'blocked':'active','goal-'+state),state);
    assert.equal(await page.locator('details').count(),0);
    assert.equal(await page.locator('[data-goal-bar] [data-goal-runtime]').count(),1);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }
  await page.getByRole('button',{name:'预算',exact:true}).click();
  assert.equal(await page.locator('[data-goal-bar] input[aria-label="轮数预算"]').count(),1);
  await page.getByRole('spinbutton',{name:'轮数预算'}).fill('0');
  assert.equal(await page.getByRole('button',{name:'保存轮数预算',exact:true}).isEnabled(),false);
  await page.getByRole('spinbutton',{name:'轮数预算'}).press('Escape');

  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:resolve(evidence,engine+'.png')});
  await page.evaluate(()=>renderGoal('absent'));
  assert.equal(await page.locator('[data-goal-bar]').count(),0);
  assert.equal(await page.locator('[data-goal-runtime]').count(),0);
  assert.equal(await page.locator('[data-goal-create]').count(),0);
  assert.equal(await page.getByRole('button',{name:'设定目标',exact:true}).count(),0);
  assert.equal(await page.evaluate(()=>calls.filter(c=>c==='create').length),0);
  // A model-created projection reveals the bar; clear/switch back to absent hides it.
  await page.evaluate(()=>renderGoal('running'));
  assert.equal(await page.locator('[data-goal-bar]').count(),1);
  await page.evaluate(()=>renderGoal('absent','active','different-session'));
  assert.equal(await page.locator('[data-goal-bar]').count(),0);
  assert.equal(await page.locator('[data-goal-runtime]').count(),0);

  assert.deepEqual(errors.filter(e=>!e.includes('isolated fixture')),[]);
  console.log(engine+': upstream GoalDock/GoalBar single inline card, confirm, retry, stale pending action, complete, blocked resume, legacy enable, narrow layout passed');
} finally {await browser.close()}
