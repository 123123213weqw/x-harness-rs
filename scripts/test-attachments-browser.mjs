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
  for(const id of ['@deepseek-ai/dsh-client-runtime','@deepseek-ai/dsh-client-ui-theme','@deepseek-ai/dsh-client-ui-attachment']) await page.addScriptTag({content:readFileSync(resolve(dist,'plugins/'+id+'/client.js'),'utf8')})
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
    const slots={}
    const api=registrations['@deepseek-ai/dsh-client-ui-attachment'].factory(id=>staticModules[id])
    api.apply({slots:{inject(_name,callback){callback()},register(definition,component){slots[definition.name]=component}}})
    const Composer=slots['conversation.input.attachments'],History=slots['conversation.message.images']
    window.added=[];window.locked=false
    function Fixture(){
      const [attachments,setAttachments]=React.useState([])
      window.toggleLock=()=>{window.locked=!window.locked;setAttachments(items=>[...items])}
      return h('main',{style:{margin:'40px auto',maxWidth:720,padding:12}},
        h('h2',{},'附件测试'),h('p',{},'拖入、粘贴或选择图片及文件'),
        h(Composer,{attachments,canAcceptDrop:!window.locked,onAddImages:files=>{window.added.push(...files.map(f=>f.name));setAttachments(items=>[...items,...files.map(file=>({id:crypto.randomUUID(),kind:file.type==='image/png'?'image':'file',file,previewUrl:URL.createObjectURL(file)}))])},onRemoveImage:id=>setAttachments(items=>items.filter(a=>a.id!==id)),t:key=>key}),
        h('textarea',{'aria-label':'消息',placeholder:'给 XHarness 发送消息',style:{width:'100%',minHeight:100,marginTop:12}}),
        h('h3',{style:{marginTop:32}},'历史附件'),h(History,{images:[{kind:'file',attachment:{attachmentId:'sha256:fixture',name:'产品说明.pdf',mediaType:'application/pdf',bytes:1234}}],loadImage:async()=>{throw Error('fixture retry')},align:'start',t:key=>key}))
    }
    ReactDOM.createRoot(document.getElementById('root')).render(h(Fixture))
  })
  await page.getByRole('button',{name:'＋ 添加附件'}).waitFor()
  const input=page.getByLabel('添加附件',{exact:true})
  await input.setInputFiles([{name:'界面.png',mimeType:'image/png',buffer:readFileSync(resolve(root,'apps/desktop/src-tauri/icons/32x32.png'))},{name:'说明.pdf',mimeType:'application/pdf',buffer:Buffer.from('pdf fixture')},{name:'main.rs',mimeType:'text/plain',buffer:Buffer.from('fn main() {}')}])
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
  await page.evaluate(()=>toggleLock());await page.waitForFunction(()=>document.querySelector('.xh-attachment-toolbar button').disabled)
  assert.equal(await page.getByRole('button',{name:'＋ 添加附件'}).isDisabled(),true)
  const evidence=resolve(root,'dist/attachment-ui-evidence');mkdirSync(evidence,{recursive:true})
  await page.screenshot({path:resolve(evidence,engine+'-mixed.png')})
  await page.setViewportSize({width:375,height:700})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true)
  await page.screenshot({path:resolve(evidence,engine+'-narrow.png')})
  assert.deepEqual(errors,[])
  console.log(engine+': real image decode/lightbox, file picker, mixed cards, remove, drop, locked input, history retry and narrow layout passed')
} finally {await browser.close()}
