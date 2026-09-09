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
    if(name==='dsh-client-ui-conversation') source=source.replace('exports.XHarnessMessageEditor =', 'exports.xhEditStorage = xhEditStorage; exports.SessionInputShell = SessionInputShell; exports.XHarnessEditAction = XHarnessEditAction; exports.XHarnessMessageEditor =');
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
    const module=load('@deepseek-ai/dsh-client-ui-conversation/client');
    window.module=module;
    const registry=new Map();let count=0;
    const conversation={createdImageUrls:new Set(),draftImages:ids=>ids.map(id=>registry.get(id)).filter(Boolean),
      createDraftImages:files=>files.map(file=>{const a={id:'i'+count++,file,previewUrl:URL.createObjectURL(file)};registry.set(a.id,a);return a;}),
      releaseDraftImage:id=>{const a=registry.get(id);if(a)URL.revokeObjectURL(a.previewUrl);registry.delete(id);}};
    window.admissions=[];window.running=false;window.failSend=false;window.missing=false;
    const shell=new module.SessionInputShell({defaultSink:async(text,ids)=>{
      editor.guardSubmit();admissions.push({text,ids});
      if(failSend)return {kind:'error'};
      await editor.sent();return {kind:'success'};
    },commandImages:{serialize:async()=>[],release:()=>{},unsupportedNotice:()=>''}});
    const store=module.xhEditStorage();
    const deps={id:'fixture',shell,conversation,storage:store,t:k=>k,running:()=>running,focus:()=>{},
      read:async()=>missing?{ok:false,error:{message:'gone'}}:{ok:true,value:{attachment:{mediaType:'image/png'},data:Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg=='),c=>c.charCodeAt(0))}}};
    const editor=new module.XHarnessMessageEditor(deps);shell.xhEditor=editor;window.editor=editor;window.shell=shell;window.deps=deps;
    const oldSubmit=shell.submit.bind(shell);shell.submit=(...args)=>{try{editor.guardSubmit();oldSubmit(...args)}catch(e){editor.set({error:String(e)})}};
    const useInput=select=>select(React.useSyncExternalStore(shell.state.subscribe,shell.state.getSnapshot));
    const root=DOM.createRoot(document.getElementById('root'));
    function App(){return React.createElement('div',{},
      React.createElement(module.XHarnessEditAction,{content:[{type:'text',text:'old message'}],editMessage:c=>editor.request(c),t:k=>k}),
      React.createElement(module.XHarnessEditableInputBar,{sessionId:'fixture',keyboard:shell,inputActions:shell.actions,
        useSession:f=>f({running:false,subagent:null,removed:false}),useInput,useNotices:()=>null,useLexicon:()=>new Map(),useMenuLauncher:()=>false,useProjection:()=>undefined,
        renderSlot:()=>null,t:k=>k,resolveSubmitMode:()=> 'queue',draftImages:ids=>conversation.draftImages(ids),
        removeImage:id=>{shell.removeImage(id);conversation.releaseDraftImage(id);},addImages:()=>null}))}
    DOM.flushSync(()=>root.render(React.createElement(App)));
  });
  // Exercise the shipped transport composer: a restored image is a durable
  // reference, never re-encoded/re-uploaded, and failed admission retains it.
  const wire = await page.evaluate(async()=>{
    const ref={historyRef:{attachmentId:'durable-old'},file:new File(['not uploaded'],'old.png')};
    let released=false,payload;
    const owner={draftImages:()=>[ref],serializeImages:()=>{throw Error('must not reupload')},releaseDraftImages:()=>{released=true}};
    const session={prompt:async(...args)=>{payload=args;return {ok:false}}};
    const outcome=await module.ConversationController.prototype.sendSession.call(owner,session,'edited',['local'],'queue',undefined,true);
    return {outcome,released,content:payload[0],options:payload[3]};
  });
  assert.deepEqual(wire,{outcome:{kind:'error'},released:false,content:[{type:'image_ref',attachmentId:'durable-old'},{type:'text',text:'edited'}],options:{requireIdle:true}});
  await page.locator('textarea').fill('unsent draft');
  await page.locator('[data-message-edit]').click();
  await page.getByRole('alertdialog').waitFor();
  assert.equal(await page.locator('textarea').inputValue(),'unsent draft');
  await page.getByRole('button',{name:'message.editConfirm',exact:true}).click();
  await page.waitForFunction(()=>shell.snapshot.draft==='old message');
  await page.locator('textarea').fill('edited message');
  await page.getByRole('button',{name:'message.editCancel',exact:true}).click();
  await page.waitForFunction(()=>shell.snapshot.draft==='unsent draft'&&editor.state.phase==='idle');
  // Real input machine failure keeps text; success clears editing and the saved transaction.
  await page.evaluate(async()=>{shell.setDraft('');await editor.request([{type:'text',text:'retry draft'}]);failSend=true;shell.submit();});
  await page.waitForFunction(()=>shell.snapshot.phase==='plain');
  assert.equal(await page.locator('textarea').inputValue(),'retry draft');
  assert.equal(await page.evaluate(()=>editor.state.editing),true);
  await page.evaluate(()=>{failSend=false;shell.submit();shell.submit();});
  await page.waitForFunction(()=>!editor.state.editing&&shell.snapshot.draft==='');
  assert.equal(await page.evaluate(()=>admissions.length),2);
  // Image-only editing, missing attachment retry and explicit removal.
  await page.evaluate(async()=>{missing=true;await editor.request([{type:'image',attachment:{attachmentId:'x',mediaType:'image/png',name:'sample.png'}}]);});
  await page.getByRole('button',{name:'message.editRetry',exact:true}).waitFor();
  await page.evaluate(()=>{missing=false;});
  await page.getByRole('button',{name:'message.editRetry',exact:true}).click();
  await page.waitForFunction(()=>deps.conversation.draftImages(shell.snapshot.imageIds)[0]?.loadState==='ready');
  await page.evaluate(()=>{running=true;shell.submit();});
  assert.equal(await page.evaluate(()=>admissions.length),2);
  await page.getByRole('button',{name:'message.editCancel',exact:true}).click();
  await page.waitForFunction(()=>editor.state.phase==='idle');
  // Compact layout remains inside the viewport.
  await page.setViewportSize({width:420,height:720});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  assert.deepEqual(errors.filter(e=>!e.includes('isolated fixture: stop host boot')),[]);
  // A genuine browser refresh preserves both File blobs and edited text in IndexedDB.
  await page.evaluate(async()=>{
    running=false;shell.setDraft('before refresh');
    const file=new File(['backup file'],'draft.png',{type:'image/png'});
    shell.addImages(deps.conversation.createDraftImages([file]).map(a=>a.id));
    await editor.request([{type:'text',text:'history'}]);await editor.confirm();
    shell.setDraft('edited before reload');await editor.writes;
  });
  const persisted=await page.evaluate(async()=>({state:editor.state,record:await deps.storage.load('fixture')}));
  assert.equal(persisted.state.phase,'editing',JSON.stringify(persisted));
  assert.equal(persisted.record?.draft.text,'edited before reload',JSON.stringify(persisted));
  await page.reload();
  const recovered=await page.evaluate(async()=>{
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('xharness-message-edits-v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
    const r=await new Promise((resolve,reject)=>{const q=db.transaction('drafts').objectStore('drafts').get('fixture');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error)});
    return {text:r.draft.text,backup:r.backup.text,file:new TextDecoder().decode(r.backup.images[0].blob),name:r.backup.images[0].name};
  });
  assert.deepEqual(recovered,{text:'edited before reload',backup:'before refresh',file:'backup file',name:'draft.png'});
  console.log(engine+': shipped message edit button, real InputMachine/composer, draft undo, failure/retry, double send, image-only, missing image and running guard passed');
} finally { await browser.close(); }
