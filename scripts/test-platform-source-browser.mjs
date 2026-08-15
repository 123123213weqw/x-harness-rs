// Full strict-source platform acceptance against the exact shipped master main.
// No Host transport, no real session data, and no production/private test exports.
import assert from 'node:assert/strict'
import {readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync} from 'node:fs'
import {join, resolve, dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'
import vm from 'node:vm'
import {compilePlatformUi} from './build-platform-ui.mjs'
import {compileSourceModules} from './build-source-modules.mjs'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),ui=join(root,'ui')
const frozen=join(ui,'reference/master-a613970'),html=readFileSync(join(frozen,'index.html'),'utf8')
const frozenEntry=html.match(/<script type="module" crossorigin src="(\/assets\/[^"?]+\.js)"/)[1]
assert.equal(frozenEntry,'/assets/index-xhmotion-347f73ecba2d.js','actual latest HTML entry, not older math/main files')
const built=compilePlatformUi(ui),sha=bytes=>createHash('sha256').update(bytes).digest('hex')
assert.ok(built.inputs.every(row=>!row.source.startsWith('reference/')&&!row.source.startsWith('legacy/')))
assert.ok(!built.inputs.some(row=>row.source.includes('vendor/npm/node_modules')),'clean npm-ci resolution only')
const modulesId='@xharness/dsh-client-modules'
const sourceModules=compileSourceModules(ui,[{id:modulesId,source:'src/modules/client-modules/index.ts'}]).get(modulesId).bytes.toString()
const frozenModules=readFileSync(join(frozen,'plugins',modulesId,'client.js'),'utf8')
const frozenRuntime=readFileSync(join(frozen,'plugins/@xharness/dsh-client-runtime/client.js'),'utf8')
const frozenBootstrap=html.match(/<script>(\(\(\)=>\{[\s\S]*?)<\/script>/)[1]
function bootstrapCase(script,modules){
 const context=vm.createContext({window:{},console,Promise,Map,Set,document:undefined})
 vm.runInContext(script,context);vm.runInContext(modules,context);vm.runInContext(frozenRuntime,context)
 const target=context.window.__ModuleLoader__;assert.equal(target.mode,'queue');assert.equal(target.pendingQueue.length,2)
 assert.throws(()=>target.create({boot:null,staticModules:{}}),/boot manifest|window\.__DSH_BOOT__/)
 // Failed create removes the modules registration like the frozen ABI: isolate
 // successful run rather than hiding this observable queue mutation.
 const success=vm.createContext({window:{},console,Promise,Map,Set,document:undefined})
 vm.runInContext(script,success);vm.runInContext(modules,success);vm.runInContext(frozenRuntime,success)
 const facade=success.window.__ModuleLoader__,react={createElement(){}}
 const system=facade.create({boot:{rev:'fixture',entries:[]},staticModules:{react}})
 assert.equal(facade.mode,'live');assert.equal(facade.pendingQueue.length,0)
 assert.equal(system.loadCache.get(modulesId).exports.apply instanceof Function,false,'VM function is from isolated realm')
 assert.equal(typeof system.loadCache.get(modulesId).exports.apply,'function')
 assert.throws(()=>facade.create({boot:{rev:'fixture',entries:[]},staticModules:{}}),/called after module-system boot/)
 return system.import('react','',{}).then(value=>assert.equal(value,react,'seed is the exact singleton, not a recreated namespace'))
}
await bootstrapCase(frozenBootstrap,frozenModules)
await bootstrapCase(built.inlineBootBytes.toString(),sourceModules)
const frozenFonts=readdirSync(join(frozen,'assets/fonts')).filter(name=>name.startsWith('KaTeX_')&&/\.(woff2?|ttf)$/.test(name))
const sourceFonts=built.files.filter(row=>row.role==='font')
assert.equal(sourceFonts.length,60);assert.equal(frozenFonts.length,59, 'latest frozen release omits Size3-Regular.woff2; keep this observed baseline gap explicit')
const frozenFontShas=frozenFonts.map(name=>sha(readFileSync(join(frozen,'assets/fonts',name))))
assert.ok(frozenFontShas.every(digest=>sourceFonts.some(row=>row.sha256===digest)), 'all 59 shipped KaTeX font byte pins retained')
assert.deepEqual(sourceFonts.filter(row=>!frozenFontShas.includes(row.sha256)).map(row=>row.sha256), ['73d591271b1604960cb10bb90fee021670af7297017e0e98480b332d11f51995'], 'only extra font is exact original missing Size3 woff2')
const require=createRequire(resolve(process.env.UI_TEST_DEPS??'/tmp/ui-tests','package.json'))
const engines=process.env.UI_TEST_BROWSER?[process.env.UI_TEST_BROWSER]:['chromium','webkit']
const evidence=resolve(root,'dist/platform-source-evidence')
mkdirSync(evidence,{recursive:true})
const cases=[
 ['inline dollar','公式 $x^2+1$ 后面继续回答。',1],
 ['inline backslash',String.raw`公式 \(\frac{a}{b}\) 后面继续。`,1],
 ['display dollar','前文\n\n$$\nx^2+y^2=z^2\n$$\n\n后文',1],
 ['same-line display','$$x^2$$\n\n后文',1],
 ['display backslash',String.raw`\[\frac{a}{b}\]`+'\n\n后文',1],
 ['matrix','$$\n'+String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`+'\n$$',1],
 ['code','`$x$`\n\n```latex\n$$x^2$$\n```',0],
 ['escaped dollar',String.raw`金额 \$20；代码 \$x\$`,0],
 ['mixed','中文 $α+β$\n\n$$\nx^2\n$$\n\n```js\nconst x="$y$";\n```',2],
 ['escaped closing','$$\nx^2\n\\$$',0],
]
for(const engine of engines){
 const browser=await require('playwright')[engine].launch({headless:true})
 try{
  const results=[]
  for(const implementation of ['frozen','source']){
   const errors=[],requests=[]
   const openPage=async()=>{
    const page=await browser.newPage({viewport:{width:960,height:720}})
    page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(new URL(r.url()).pathname));page.setDefaultTimeout(15000)
    const entry=implementation==='source'?'/'+built.entryPath:frozenEntry
    const sourceCss=implementation==='source'?built.cssPaths:[]
    const sharedCss=[...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map(x=>x[1])
    await page.route('**/*',route=>{
     const pathname=new URL(route.request().url()).pathname,local=pathname.slice(1)
     if(pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><html><head>${[...sharedCss,...sourceCss.map(x=>'/'+x)].map(path=>`<link rel="stylesheet" href="${path}">`).join('')}<script>window.__ModuleLoader__={create:options=>{window.staticModules=options.staticModules;throw Error('isolated platform: stop Host boot')}};</script><script type="module" src="${entry}"></script></head><body><div id="root"></div></body></html>`})
     const bytes=implementation==='source'&&built.outputs.has(local)?built.outputs.get(local):existsSync(join(frozen,local))?readFileSync(join(frozen,local)):undefined
     if(bytes)return route.fulfill({body:bytes,contentType:local.endsWith('.css')?'text/css':local.endsWith('.woff2')?'font/woff2':local.endsWith('.woff')?'font/woff':local.endsWith('.ttf')?'font/ttf':'application/javascript'})
     return route.abort()
    })
    await page.goto('http://platform-fixture.test/');await page.waitForFunction(()=>window.staticModules)
    return page
   }
   let page=await openPage()
   const keys=await page.evaluate(()=>Object.keys(staticModules).sort())
   assert.deepEqual(keys,['@xharness/cordis','@xharness/dsh-client-ui-primitives','@xharness/dsh-client-ui-slots','react','react-dom','react-dom/client','react/jsx-runtime'].sort(),'actual master static platform words')
   const singleton=await page.evaluate(()=>{
    const R=staticModules.react,J=staticModules['react/jsx-runtime'];return {version:R.version,element:J.jsx('span',{}).$$typeof===R.createElement('span').$$typeof,createRoot:staticModules['react-dom/client'].createRoot===staticModules['react-dom'].createRoot}
   });assert.equal(singleton.version,'18.3.1');assert.ok(singleton.element);assert.ok(singleton.createRoot)
   const initializeRoot=()=>{
    const R=staticModules.react,D=staticModules['react-dom'],P=staticModules['@xharness/dsh-client-ui-primitives']
    window.mount=D.createRoot(document.getElementById('root'));window.labels={copyLabel:'copy',copiedLabel:'copied'}
    window.renderMath=(text,streaming=true,key='test')=>D.flushSync(()=>mount.render(R.createElement(P.MarkdownText,{text,streaming,key,codeLabels:labels})))
    window.normalize=node=>node.nodeType===Node.TEXT_NODE?node.textContent:{tag:node.nodeName,style:node.getAttribute('style'),children:[...node.childNodes].map(normalize)}
   }
   await page.evaluate(initializeRoot)
   const projection=[]
   for(const [name,text,count] of cases){
    for(let i=1;i<=text.length;i++)await page.evaluate(({text,key})=>renderMath(text,true,key),{text:text.slice(0,i),key:name})
    assert.equal(await page.locator('.katex').count(),count,implementation+'/'+name+' before stream ends')
    const streaming=await page.evaluate(()=>normalize(document.getElementById('root')))
    await page.evaluate(({text,key})=>renderMath(text,false,key),{text,key:name})
    const finalCount=await page.locator('.katex').count()
    if(name!=='escaped closing')assert.equal(finalCount,count,implementation+'/'+name+' final count')
    // Streaming fences intentionally have no language. Once settled, common
    // fences now share the lazy/read lifecycle: immediate exact text, then
    // the same colored DOM. Do not make a network timing race the oracle.
    if(name==='mixed'){
     assert.equal(await page.locator('.md-code-block pre').textContent(),'const x="$y$";')
     await page.waitForFunction(()=>document.querySelector('.md-code-block .shiki'))
    }
    const settled=await page.evaluate(()=>normalize(document.getElementById('root')))
    projection.push({name,streaming,settled})
   }
   for(const text of ['$$','$$\nx^2',String.raw`\[x^2`,String.raw`\(x^2`,'$x^2']){
    await page.evaluate(text=>renderMath(text,true,'partial'),text);assert.equal(await page.locator('.katex').count(),0)
   }
   await page.evaluate(()=>{renderMath('$a^2$\n\nsecond\n\nthird\n\nfourth',true,'freeze');window.firstFormula=document.querySelector('.katex')})
   await page.evaluate(()=>renderMath('$a^2$\n\nsecond\n\nthird\n\nfourth more',true,'freeze'))
   assert.ok(await page.evaluate(()=>firstFormula===document.querySelector('.katex')),'frozen formula DOM retained')
   await page.evaluate(()=>renderMath('Replacement text',true,'freeze'));assert.equal(await page.locator('.katex').count(),0)
   await page.evaluate(()=>{
    const R=staticModules.react,D=staticModules['react-dom'],P=staticModules['@xharness/dsh-client-ui-primitives']
    D.flushSync(()=>mount.render(R.createElement('div',{},R.createElement(P.FishLogo,{size:64}),R.createElement(P.BrandWordmark,{size:32}),R.createElement(P.CodeBlock,{code:'def answer():\n    return 42',lang:'python'}))))
   })
   await page.waitForFunction(()=>document.querySelector('.md-code-block .shiki'))
   const brand=await page.evaluate(()=>({svg:[...document.querySelectorAll('#root svg')].map(el=>({viewBox:el.getAttribute('viewBox'),width:el.getAttribute('width'),height:el.getAttribute('height'),paths:[...el.querySelectorAll('path')].map(p=>[p.getAttribute('d'),p.getAttribute('fill-opacity')]),text:el.textContent})),code:normalize(document.querySelector('.md-code-block pre'))}))
   assert.equal(brand.svg[0].viewBox,'0 0 64 64');assert.equal(brand.svg[0].paths.length,2)
   assert.ok(requests.some(path=>/python/.test(path)),'actual dynamic Shiki grammar request')
   const shiki=[]
   for(const [lang,code] of [
    ['typescript','export async function main<T>(x: T) { return await Promise.resolve(x) }'],
    ['typescript','const s = `a${1+2}b`;\n// 中文\nconst rx = /(?<n>\\d+)/giu;'],
    ['typescript','const x = "unfinished'],
    ['shellscript',`printf '%s\\n' "$HOME"`],
    ['shellscript',`cat <<'EOF'\nhello $HOME\nEOF\necho done`],
    ['shellscript','cat <<END\nhello $HOME\nEND\necho done'],
    ['json','{"text":"中文","nested":[true,null],"value":1.2e-3}'],
    ['json','{"stream":"unfinished'],
   ]){
    await page.evaluate(({lang,code})=>{
     const R=staticModules.react,D=staticModules['react-dom'],P=staticModules['@xharness/dsh-client-ui-primitives']
     D.flushSync(()=>mount.render(R.createElement(P.CodeBlock,{key:lang+code,code,lang})))
    },{lang,code})
    await page.waitForFunction(()=>document.querySelector('.md-code-block .shiki'))
    shiki.push({lang,code,html:await page.evaluate(()=>normalize(document.querySelector('.md-code-block pre')))})
   }
   const coreAbi=await page.evaluate(async()=>{
    const C=staticModules['@xharness/cordis'],S=staticModules['@xharness/dsh-client-ui-slots']
    class Fixture extends C.Service {
     constructor(ctx){super(ctx,'fixture')}
     scope(){return this.ctx.fixtureScope}
     get liveScope(){const value=this.ctx;if(!C.Context.is(value))throw Error('not CoreContext');return value.fixtureScope}
    }
    const context=new C.Context(),service=new Fixture(context),caller=context.extend({fixtureScope:'caller'})
    const tracker={method:caller.fixture.scope(),getter:caller.fixture.liveScope,sameRoot:caller.fixture.ctx.root===context.root,instance:caller.fixture instanceof Fixture}
    const slots=new S.SlotCore(),mutations=[],declared=[],batched=[]
    slots.onMutate(key=>mutations.push(key));slots.subscribeDeclaration('list',()=>declared.push(slots.declarationEpoch('list')));slots.subscribe('list',()=>batched.push(slots.getVersion('list')))
    const parent=slots.register({name:'root',children:{list:{kind:'list',scope:'root'},chain:{kind:'chain',scope:'root'},keyed:{kind:'keyed',scope:'root'}}},'parent')
    const first=slots.register({name:'list',id:'a',order:2,priority:1},'shadow')
    const winner=slots.register({name:'list',id:'a',order:1,priority:0},'winner')
    slots.register({name:'list',id:'b',order:0},'b')
    const selected=slots.entriesOfSlot('list').map(e=>e.component)
    const winnerEntry=slots.entriesOfSlot('list').find(e=>e.component==='winner')
    slots.reportEntryError('list',winnerEntry,Error('fixture'),{abdicate:true})
    const fallback=slots.entriesOfSlot('list').map(e=>e.component)
    slots.register({name:'chain',select:()=>null,priority:3},'later');slots.register({name:'chain',select:()=>({matched:true}),priority:0},'earlier')
    slots.register({name:'keyed',key:'x',priority:2},'old-key');slots.register({name:'keyed',key:'x',priority:0},'new-key')
    const chain=slots.entriesOfSlot('chain').map(e=>e.component),keyed=slots.entriesOfSlot('keyed').map(e=>e.component)
    await Promise.resolve();const before=slots.snapshot();parent();winner();first();await Promise.resolve()
    const cascaded={entries:slots.entries('list').length,spec:slots.specDynamic('list'),live:slots.isLive(winnerEntry)}
    await context.fiber.dispose()
    return {tracker,selected,fallback,chain,keyed,before,cascaded,mutations,declared,batched}
   })
   assert.deepEqual(coreAbi.tracker,{method:'caller',getter:'caller',sameRoot:true,instance:true},'actual Core Service tracker preserves caller through methods and guarded getter')
   assert.deepEqual(coreAbi.selected,['b','winner']);assert.deepEqual(coreAbi.fallback,['b','shadow']);assert.deepEqual(coreAbi.chain,['earlier','later']);assert.deepEqual(coreAbi.keyed,['new-key']);assert.equal(coreAbi.cascaded.live,false)
   // Independent fixture, not a replacement of the streaming/Shiki scene.
   // CI retained two raster pixels outside every live surface element in the
   // initial 960px scene; viewport changes happened to erase them. Start with
   // a fresh document instead of masking pixels, tolerating differences, or
   // relying on that incidental resize. The exact pixel oracle is unchanged.
   await page.close();page=await openPage();await page.evaluate(initializeRoot)
   assert.deepEqual(await page.evaluate(()=>Object.keys(staticModules).sort()),keys)
   await page.addStyleTag({content:'*,*::before,*::after {animation:none !important;transition:none !important;caret-color:transparent !important} #fixture {padding:24px;display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap} '})
   await page.evaluate(()=>{
    const R=staticModules.react,D=staticModules['react-dom'],P=staticModules['@xharness/dsh-client-ui-primitives']
    window.fixtureCloseCount=0;window.selected=[]
    window.renderSurface=(kind='base')=>D.flushSync(()=>mount.render(R.createElement('div',{id:'fixture'},
     ...['primary','ghost','outline','toolbar'].map(variant=>R.createElement(P.Button,{key:variant,variant},variant)),
     R.createElement(P.Pill,{active:true},'Active'),R.createElement(P.Input,{defaultValue:'Input value','aria-label':'Input'}),
     R.createElement(P.StateDot,{state:'done'}),R.createElement(P.DisclosureRow,{title:'Disclosure',icon:'i',open:true,expandable:true,onToggle:()=>{}},'content'),
     R.createElement(P.JsonTree,{data:{a:1,nested:{x:'text'},array:[1,2]}}),
     R.createElement(P.MarkdownText,{text:'Formula $x^2$ and **bold**\n\n$$\nx^2+y^2\n$$',streaming:true}),
     kind==='menu'?R.createElement(P.Menu,{open:true,portal:true,anchor:R.createElement(P.Button,{},'Menu anchor'),items:[{type:'label',id:'label',text:'Heading'},{id:'a',label:'Alpha'},{type:'separator',id:'s'},{id:'b',label:'Disabled',disabled:true}],footer:[{id:'f',label:'Footer'}],onSelect:id=>selected.push(id),onClose:()=>fixtureCloseCount++}):null,
     kind==='modal'?R.createElement(P.Modal,{open:true,title:'Modal title',description:'Description',onClose:()=>fixtureCloseCount++,footer:R.createElement(P.Button,{variant:'primary'},'Confirm')},'Modal body'):null)))
    // The owned modal intentionally moved into the native top layer. Compare
    // the feature-owned card (same geometry/tokens), not the transport wrapper.
    window.layout=()=>{
     const surface=document.querySelector('[role=dialog]')
     const card=surface?.tagName==='DIALOG'?surface.querySelector('[class*=dialog]'):surface
     return [...document.querySelectorAll('#fixture *'),...(card?[card,...card.querySelectorAll('*')]:[])].map(el=>{
     const r=el.getBoundingClientRect(),css=getComputedStyle(el),before=getComputedStyle(el,'::before'),after=getComputedStyle(el,'::after')
     const names=['display','position','color','backgroundColor','fontFamily','fontSize','fontWeight','lineHeight','padding','margin','border','borderRadius','gap','boxShadow','opacity','animationDuration','animationTimingFunction','transform','overflow','maxWidth','maxHeight']
     return {tag:el.tagName,text:el.children.length?null:el.textContent,rect:[r.x,r.y,r.width,r.height],style:Object.fromEntries(names.map(name=>[name,css[name]])),before:{content:before.content,width:before.width,height:before.height,backgroundColor:before.backgroundColor},after:{content:after.content,width:after.width,height:after.height,backgroundColor:after.backgroundColor}}
    })}
   })
   const surfaces=[],screenshots=[]
   for(const theme of ['light','dark'])for(const width of [960,390])for(const kind of ['base','menu','modal']){
    await page.setViewportSize({width,height:720});await page.evaluate(({theme,kind})=>{if(theme==='dark')document.body.setAttribute('data-ds-dark-theme','');else document.body.removeAttribute('data-ds-dark-theme');renderSurface(kind)},{theme,kind})
    if(kind==='modal')await page.getByRole('button',{name:'Confirm',exact:true}).focus()
    await page.evaluate(()=>document.fonts.ready);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
    surfaces.push({theme,width,kind,layout:await page.evaluate(()=>layout())});screenshots.push(sha(await page.screenshot({animations:'disabled',path:join(evidence,`${engine}-${implementation}-${theme}-${width}-${kind}.png`)})))
    if(kind==='modal'){await page.keyboard.press('Escape');assert.ok(await page.evaluate(()=>fixtureCloseCount>0),'actual modal Escape routes onClose')}
   }
   if(implementation==='source'){
    // Additional owning-theme acceptance, AFTER the independent platform
    // snapshots above. Never project/mask or update the frozen pixel oracle.
    await page.addStyleTag({content:readFileSync(join(ui,'src/modules/theme/typography.css'),'utf8')})
    const text='# **H1**\n\n## **H2**\n\n### **H3**\n\n#### **H4**\n\n##### **H5**\n\n###### **H6**\n\n正文 **强调** English $x^2$\n\n```text\ncode value\n```\n\n| Head |\n| --- |\n| body |\n\n末尾'
    for(const theme of ['light','dark'])for(const width of [960,390]){
     await page.setViewportSize({width,height:720})
     await page.evaluate(({text,theme})=>{
      document.body.toggleAttribute('data-ds-dark-theme',theme==='dark')
      renderMath(text,true,'typography')
     },{text,theme})
     const computed=await page.evaluate(()=>{
      const css=selector=>{const s=getComputedStyle(document.querySelector(selector));return {size:s.fontSize,weight:s.fontWeight,line:s.lineHeight,margin:s.margin}}
      return {headings:['h1','h2','h3','h4','h5','h6'].map(h=>[css(h),css(h+' strong')]),body:css('#root p'),emphasis:css('#root p strong'),code:css('.md-code-block pre'),table:css('#root th')}
     })
     for(const [i,size,weight] of [[0,24,700],[1,20,700],[2,18,700],[3,17,600],[4,16,600],[5,16,600]]){
      assert.equal(computed.headings[i][0].size,size+'px',engine+'/'+theme+'/'+width+'/heading size')
      assert.equal(computed.headings[i][0].weight,''+weight)
      assert.equal(computed.headings[i][1].weight,''+weight,'heading emphasis inherits hierarchy')
     }
     assert.deepEqual(computed.body,{size:'16px',weight:'400',line:'28px',margin:'14px 0px'},'body size unchanged, theme paragraph rhythm active')
     assert.equal(computed.emphasis.weight,'700')
     assert.equal(computed.code.size,'14px');assert.equal(computed.code.line,'24px')
     assert.equal(computed.table.weight,'600')
     assert.equal(await page.locator('.katex').count(),1,'math appears while streaming')
     await page.evaluate(text=>renderMath(text,false,'typography'),text)
     assert.equal(await page.locator('.md-code-block pre').textContent(),'code value','settling preserves exact code')
    }
   }
   assert.deepEqual(errors,[])
   results.push({keys,singleton,projection,brand,shiki,coreAbi,surfaces,screenshots});await page.close()
  }
  writeFileSync(join(evidence,`${engine}-results.json`),JSON.stringify(results,null,2)+'\n')
  const {screenshots:expectedPixels,...expected}=results[0],{screenshots:actualPixels,...actual}=results[1]
  assert.deepEqual(actual,expected,`${engine}: exact semantic math/brand/Shiki DOM and singleton ABI`)
  assert.deepEqual(actualPixels,expectedPixels,`${engine}: exact pixels; see dist/platform-source-evidence/ for both PNGs and layout records`)
  console.log(`${engine}: frozen/source platform keys, singleton, 10 streamed math scenarios, partial/frozen/retry, brand/lazy Shiki, 8 exact on-demand/common grammar scenes, tracked Core Service, SlotCore lifecycle and 12 computed-layout/pixel snapshots passed`)
 }finally{await browser.close()}
}
console.log(`typed HTML queue/live bootstrap and 59 frozen / ${sourceFonts.length} npm KaTeX font byte pins passed; ${built.files.length} emitted platform assets`)
