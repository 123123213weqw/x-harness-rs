// Real shipped attachment React UI, isolated from user sessions and paid models.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root=fileURLToPath(new URL('../',import.meta.url)),dist=resolve(root,'ui/dist')
const require=createRequire(resolve(process.env.UI_TEST_DEPS??'/tmp/ui-tests','package.json'))
const engine=process.env.UI_TEST_BROWSER??'chromium'
const browser=await require('playwright')[engine].launch({headless:true,...(process.env.UI_TEST_EXECUTABLE?{executablePath:process.env.UI_TEST_EXECUTABLE}:{})})
try {
  const page=await browser.newPage({viewport:{width:960,height:720}}),errors=[]
  page.setDefaultTimeout(8000)
  page.on('pageerror',e=>{if(!e.message.includes('isolated fixture')){errors.push(e.message);console.error('PAGE ERROR',e.message)}})
  const assets=readdirSync(resolve(dist,'assets')),entry=assets.find(n=>/^index-.*\.js$/.test(n))
  await page.route('**/*',route=>{
    const url=new URL(route.request().url())
    // WebKit routes blob requests; Chromium resolves them without interception.
    // Keep fixture network blocked, but allow locally selected File previews.
    if(url.protocol==='blob:')return route.continue()
    const pathname=url.pathname,name=pathname.slice('/assets/'.length)
    if(pathname.startsWith('/assets/')&&assets.includes(name))return route.fulfill({body:readFileSync(resolve(dist,'assets',name)),contentType:name.endsWith('.css')?'text/css':'application/javascript'})
    if(pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><html><head>${assets.filter(n=>n.endsWith('.css')).map(n=>`<link rel="stylesheet" href="/assets/${n}">`).join('')}<script>window.__ModuleLoader__={create:options=>{window.staticModules=options.staticModules;throw Error('isolated fixture')}}</script><script type="module" src="/assets/${entry}"></script></head><body><div id="root"></div></body></html>`})
    return route.abort()
  })
  await page.goto('https://attachment-fixture.test/')
  await page.waitForFunction(()=>window.staticModules)
  await page.evaluate(()=>{window.registrations={};window.__ModuleLoader__={load:r=>registrations[r.id]=r}})
  for(const name of readdirSync(resolve(dist,'plugins/@deepseek-ai'))) {
    let content=readFileSync(resolve(dist,'plugins/@deepseek-ai',name,'client.js'),'utf8')
    if(name==='dsh-client-ui-conversation') content=content.replace('exports.ConversationController =', 'exports.InputBar = InputBar; exports.SessionInputShell = SessionInputShell; exports.ConversationController =')
    await page.addScriptTag({content})
  }
  await page.evaluate(()=>{
    const React=staticModules.react,h=React.createElement,ReactDOM=staticModules['react-dom']
    const runtime=registrations['@deepseek-ai/dsh-client-runtime'].factory(id=>staticModules[id])
    const readModule=id=>id==='@deepseek-ai/dsh-client-runtime/client'?{...runtime,defineStore:spec=>spec}:staticModules[id]
    const ctx={effect:fn=>fn(),provide:(name,value)=>{ctx[name]=value},on:()=>{},emit:()=>{},settingsScope:{bind:()=>({subscribe:()=>()=>{},getSnapshot:()=>({value:{preference:'light'}})})},locale:{register:()=>()=>{}},slots:{inject:()=>{}}}
    registrations['@deepseek-ai/dsh-client-ui-theme'].factory(readModule).apply(ctx)
    document.documentElement.dataset.theme='light'
    for(const [name,value] of Object.entries(ctx.theme.getTheme().active.tokens))document.documentElement.style.setProperty(name,value)
    document.body.style.fontFamily='system-ui,sans-serif'
    document.body.style.background='var(--dsw-alias-bg-base)'
    document.body.style.color='var(--dsw-alias-label-primary)'
    const slots={}
    const cache={};function load(id){if(staticModules[id])return staticModules[id];const name=id.endsWith('/client')?id.slice(0,-7):id;return cache[name]??(cache[name]=registrations[name].factory(load))}
    const api=load('@deepseek-ai/dsh-client-ui-attachment/client')
    api.apply({slots:{inject(_name,callback){callback()},register(definition,component){slots[definition.name]=component}}})
    const Composer=slots['conversation.input.attachments'],History=slots['conversation.message.images']
    const module=load('@deepseek-ai/dsh-client-ui-conversation/client')
    const owner=Object.assign(Object.create(module.ConversationController.prototype),{draftAttachments:new Map(),createdImageUrls:new Set()})
    const shell=new module.SessionInputShell({defaultSink:async()=>({kind:'error'}),commandImages:{serialize:async()=>[],release:()=>{},unsupportedNotice:()=>''}})
    const useInput=select=>select(React.useSyncExternalStore(shell.state.subscribe,shell.state.getSnapshot))
    const labels={'input.add':'添加附件或命令','input.attachFiles':'添加图片或文件','input.commands':'命令','input.send':'发送','placeholder.default':'给 XHarness 发送消息'}
    const t=key=>labels[key]??key
    window.added=[];window.locked=false;window.commandCalls=[];window.sessionId='fixture';window.shell=shell
    window.setTheme=preference=>{
      document.documentElement.dataset.theme=preference
      document.body.toggleAttribute('data-ds-dark-theme',preference==='dark')
      const theme=ctx.theme.getTheme().themes.find(theme=>theme.id===preference)
      if(theme)for(const [name,value] of Object.entries(theme.tokens))document.documentElement.style.setProperty(name,value)
    }
    function Fixture(){
      const [,rerender]=React.useState(0)
      window.toggleLock=()=>{window.locked=!window.locked;rerender(n=>n+1)}
      window.changeSession=()=>{window.sessionId+='-next';rerender(n=>n+1)}
      return h('main',{style:{margin:'160px auto 40px',maxWidth:720,padding:12}},
        h('h2',{},'开始新的对话'),
        h(module.InputBar,{sessionId,disabled:locked,keyboard:shell,inputActions:shell.actions,
          useSession:select=>select({running:false,subagent:null,removed:false}),useInput,
          useNotices:()=>null,useLexicon:()=>new Map(),useMenuLauncher:()=>false,useProjection:()=>undefined,
          renderSlot:(name,props)=>name==='conversation.input.attachments'?h(Composer,{...props,t}):null,t,
          resolveSubmitMode:()=> 'queue',draftImages:ids=>owner.draftImages(ids),
          toggleCommandMenu:selection=>commandCalls.push(selection),
          addImages:files=>{const images=owner.createDraftImages(files);const accepted=shell.addImages(images.map(a=>a.id));if(accepted)added.push(...files.map(f=>f.name));else owner.releaseDraftImages(images);return accepted?null:'locked'},
          removeImage:id=>{shell.removeImage(id);owner.releaseDraftImage(id)}}),
        h('button',{type:'button','data-outside':true,style:{marginTop:16}},'聊天框外'),
        h('h3',{style:{marginTop:32}},'历史附件'),h(History,{images:[{kind:'file',attachment:{attachmentId:'sha256:fixture',name:'产品说明.pdf',mediaType:'application/pdf',bytes:1234}}],loadImage:async()=>{throw Error('fixture retry')},align:'start',t:key=>key}))
    }
    ReactDOM.createRoot(document.getElementById('root')).render(h(Fixture))
  })
  const plus=page.getByRole('button',{name:'添加附件或命令',exact:true}),input=page.getByLabel('添加图片或文件',{exact:true}),textarea=page.locator('textarea')
  await plus.waitFor()
  assert.equal(await page.locator('.xh-attachment-toolbar').count(),0)
  assert.equal(await page.locator('[data-composer-card] [data-composer-add-menu]').count(),1)
  const evidence=resolve(root,'dist/attachment-ui-evidence');mkdirSync(evidence,{recursive:true})
  await page.screenshot({path:resolve(evidence,engine+'-empty.png')})
  await textarea.fill('保留当前草稿')
  await textarea.evaluate(el=>el.setSelectionRange(2,4))
  await plus.click()
  const menu=page.getByRole('menu')
  await menu.waitFor()
  await page.screenshot({path:resolve(evidence,engine+'-plus-menu.png')})
  const cardBox=await page.locator('[data-composer-card]').boundingBox(),menuBox=await menu.boundingBox()
  const clipTop=Math.min(cardBox.y,menuBox.y)-12
  await page.screenshot({path:resolve(evidence,engine+'-menu-detail.png'),clip:{x:cardBox.x-12,y:clipTop,width:cardBox.width+24,height:cardBox.y+cardBox.height-clipTop+12}})
  assert.equal(await page.getByRole('menuitem',{name:'添加图片或文件'}).evaluate(el=>el===document.activeElement),true)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await menu.waitFor({state:'detached'})
  assert.deepEqual(await page.evaluate(()=>commandCalls),[{start:2,end:4}])
  assert.equal(await textarea.inputValue(),'保留当前草稿')
  await plus.focus();await page.keyboard.press('ArrowDown');await menu.waitFor()
  await page.keyboard.press('Escape');await menu.waitFor({state:'detached'})
  assert.equal(await plus.evaluate(el=>el===document.activeElement),true)
  await plus.click();await menu.waitFor();await page.keyboard.press('Tab');await menu.waitFor({state:'detached'})
  await plus.click();await page.locator('[data-outside]').click();await menu.waitFor({state:'detached'})
  await plus.click()
  const chooser=page.waitForEvent('filechooser')
  await page.getByRole('menuitem',{name:'添加图片或文件'}).click()
  const dialog=await chooser
  assert.equal(dialog.isMultiple(),true)
  await dialog.setFiles([{name:'界面.png',mimeType:'image/png',buffer:readFileSync(resolve(root,'apps/desktop/src-tauri/icons/32x32.png'))},{name:'说明.pdf',mimeType:'application/pdf',buffer:Buffer.from('pdf fixture')},{name:'main.rs',mimeType:'text/plain',buffer:Buffer.from('fn main() {}')}])
  assert.deepEqual(await page.evaluate(()=>added),['界面.png','说明.pdf','main.rs'])
  const thumbnail=page.getByRole('img',{name:'界面.png',exact:true})
  await thumbnail.waitFor()
  try { await page.waitForFunction(()=>Array.from(document.images).some(i=>i.alt==='界面.png'&&i.complete&&i.naturalWidth===32)) }
  catch(error) {
    console.error('Image diagnostic',await page.evaluate(()=>Array.from(document.images).map(i=>({alt:i.alt,complete:i.complete,width:i.naturalWidth,source:i.currentSrc}))))
    const evidence=resolve(root,'dist/attachment-ui-evidence');mkdirSync(evidence,{recursive:true})
    await page.screenshot({path:resolve(evidence,engine+'-failure.png')})
    throw error
  }
  await thumbnail.click()
  const lightbox=page.getByRole('dialog',{name:'image.preview'})
  await lightbox.waitFor()
  assert.equal(await lightbox.getByRole('img',{name:'界面.png'}).count(),1)
  await page.keyboard.press('Escape')
  await lightbox.waitFor({state:'detached'})
  await page.getByText('说明.pdf',{exact:true}).waitFor()
  const remove=page.locator('.xh-file-remove').first();await remove.click()
  assert.equal(await page.getByText('说明.pdf',{exact:true}).count(),0)
  await page.evaluate(()=>{
    const transfer=new DataTransfer();transfer.items.add(new File(['log'],'日志.log',{type:'text/plain'}))
    document.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:transfer}))
  })
  await page.getByText('日志.log',{exact:true}).waitFor()
  await page.getByRole('button',{name:/产品说明.pdf/}).click()
  await page.getByText('读取失败，点击重试',{exact:true}).waitFor()
  await textarea.evaluate(el=>{const data=new DataTransfer();data.items.add(new File(['paste'],'粘贴.txt',{type:'text/plain'}));el.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:data}))})
  await page.getByText('粘贴.txt',{exact:true}).waitFor()
  // Empty selection/cancel leaves both text and attachments intact.
  const count=await page.evaluate(()=>added.length)
  await input.setInputFiles([])
  assert.equal(await page.evaluate(()=>added.length),count)
  assert.equal(await textarea.inputValue(),'保留当前草稿')
  await input.setInputFiles({name:'same.txt',mimeType:'text/plain',buffer:Buffer.from('same')})
  await input.setInputFiles({name:'same.txt',mimeType:'text/plain',buffer:Buffer.from('same')})
  assert.equal(await page.evaluate(()=>added.filter(name=>name==='same.txt').length),2)
  await plus.click();await page.evaluate(()=>toggleLock())
  await page.waitForFunction(()=>document.querySelector('[data-composer-add-menu] button').disabled)
  await menu.waitFor({state:'detached'})
  assert.equal(await plus.isDisabled(),true);assert.equal(await input.isDisabled(),true)
  const lockedCount=await page.evaluate(()=>added.length)
  await page.evaluate(()=>{const input=document.querySelector('[data-composer-add-menu] input');const data=new DataTransfer();data.items.add(new File(['late'],'late.txt'));Object.defineProperty(input,'files',{configurable:true,value:data.files});input.dispatchEvent(new Event('change',{bubbles:true}));delete input.files})
  assert.equal(await page.evaluate(()=>added.length),lockedCount,'late file dialog result while locked is ignored')
  await page.evaluate(()=>toggleLock())
  await page.screenshot({path:resolve(evidence,engine+'-mixed.png')})
  await page.setViewportSize({width:375,height:700})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true)
  await page.screenshot({path:resolve(evidence,engine+'-narrow.png')})
  await plus.click();await menu.waitFor()
  const bounds=await menu.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=375&&bounds.y>=0)
  await page.screenshot({path:resolve(evidence,engine+'-narrow-menu.png')})
  const lightMenu=await menu.evaluate(el=>getComputedStyle(el).backgroundColor)
  await page.evaluate(()=>setTheme('dark'))
  assert.notEqual(await menu.evaluate(el=>getComputedStyle(el).backgroundColor),lightMenu,'dark theme must actually change menu palette')
  await page.screenshot({path:resolve(evidence,engine+'-dark-menu.png')})
  await page.evaluate(()=>changeSession());await menu.waitFor({state:'detached'})
  assert.deepEqual(errors,[])
  console.log(engine+': actual composer plus, commands/caret, keyboard/outside close, mixed picker, image/lightbox, drop/paste, cancel/reselect, late locked result, session switch and narrow layout passed')
} finally {await browser.close()}
