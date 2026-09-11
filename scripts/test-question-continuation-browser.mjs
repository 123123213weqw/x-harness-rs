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
    if(name==='dsh-client-ui-user-questions') source=source.replace('exports.PendingQuestion =','exports.QuestionComposer = QuestionComposer; exports.PendingQuestion =');
    if(name==='dsh-client-ui-conversation') source=source.replace('exports.XHarnessMessageEditor =', 'exports.XhCheckpointView = XhCheckpointView; exports.xhCheckpointDefinition = xhCheckpointDefinition; exports.XHarnessMessageEditor =');
    await page.addScriptTag({content:source});
  }
  await page.evaluate(() => {
    const cache={};function load(id){if(staticModules[id])return staticModules[id];const name=id.endsWith('/client')?id.slice(0,-7):id;if(cache[name])return cache[name];return cache[name]=registrations[name].factory(load)};
    const React=staticModules.react,DOM=staticModules['react-dom'];
    const module=load('@deepseek-ai/dsh-client-ui-user-questions/client');
    const root=DOM.createRoot(document.getElementById('root'));window.answers=[];
    window.renderQuestion=(deferred=false,key='q:test')=>{
      const wait={key,sessionId:'test',payload:{deferred,questions:[{id:'target',header:'选择',question:'Choose target?',options:[],multiSelect:false}]},respond:async answer=>{answers.push(answer);return {accepted:true}}};
      DOM.flushSync(()=>root.render(React.createElement('div',{'data-composer-seat':''},
        React.createElement('div',{'data-slot':'conversation.composer'},
          React.createElement('div',{'data-chain-overlay-fallback':'conversation.composer',style:{display:'none'}},
            React.createElement('div',{'data-normal-composer':''},React.createElement('textarea',{'aria-label':'Message the agent'}))),
          key==='approval' ? React.createElement('div',{'data-approval':''},'Approval required') :
          React.createElement(module.QuestionComposer,{matched:wait,t:key=>key})))));
    };renderQuestion();
  });
  const input=page.locator('[data-question-key] textarea');
  const composer=page.getByRole('textbox',{name:'Message the agent',exact:true});
  assert.equal(await composer.isVisible(),false,'blocking question retains takeover');
  await input.fill('my partial answer');
  await page.evaluate(()=>renderQuestion(true));
  assert.equal(await page.locator('[data-question-deferred="true"]').count(),1);
  assert.equal(await input.count(),0,'timeout automatically folds question body');
  assert.equal(await composer.isVisible(),true,'deferred question releases normal composer');
  await composer.fill('independent message draft');
  await page.getByRole('button',{name:'展开待回答问题',exact:true}).click();
  assert.equal(await input.inputValue(),'my partial answer','same-question timeout must retain draft');
  assert.equal(await composer.inputValue(),'independent message draft');
  assert.equal(await page.evaluate(()=>answers.length),0,'timeout is not an answer');
  await page.getByRole('status').getByText(/等待回答/).waitFor();
  await page.evaluate(()=>renderQuestion(true));
  assert.equal(await page.locator('[data-question-key]').count(),1,'replayed notification does not duplicate question');
  assert.equal(await input.inputValue(),'my partial answer');
  assert.equal(await input.isVisible(),true,'duplicate deferred frame must not fold manually reopened card');
  await page.getByRole('button',{name:'nav.minimize',exact:true}).click();
  assert.equal(await composer.isVisible(),true);
  await page.setViewportSize({width:390,height:720});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=390),true,'narrow viewport must not overflow');
  await page.getByRole('button',{name:'展开待回答问题',exact:true}).click();
  assert.equal(await input.inputValue(),'my partial answer');
  await page.evaluate(()=>renderQuestion(true,'q:restored'));
  assert.equal(await input.count(),0,'restored deferred question starts folded');
  await page.evaluate(()=>renderQuestion(false,'q:another'));
  assert.equal(await input.inputValue(),'','different question must not inherit another draft');
  assert.equal(await composer.isVisible(),false,'next blocking question takes over');
  await page.evaluate(()=>renderQuestion(true,'approval'));
  assert.equal(await composer.isVisible(),false,'approval winner must never be unblocked');
  assert.equal(await page.getByRole('status').filter({hasText:'等待回答'}).count(),0);
  assert.deepEqual(errors.filter(e=>!e.includes('isolated fixture')),[]);
  console.log(engine+': question deferred banner, draft preserved, no implicit answer, repeated frame, session isolation, automatic fold, restored fold, normal composer, approval isolation, narrow layout passed');
} finally {await browser.close()}
