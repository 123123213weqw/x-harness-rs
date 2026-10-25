// Real source component + source platform; native hand-offs are recorded, never executed.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import {mkdirSync} from 'node:fs'
import {compileSourceModules} from './build-source-modules.mjs'
import {installOwnedViewPlatform} from './fixtures/owned-view-platform-browser.mjs'
const require=createRequire(resolve(process.env.UI_TEST_DEPS??'/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps','package.json'))
const engine=process.env.UI_TEST_BROWSER??'chromium'
const browser=await require('playwright')[engine].launch({headless:true})
const id='@xharness/dsh-client-ui-deliverables'
const output=compileSourceModules(resolve('ui'),[{id,source:'src/modules/deliverables/index.ts'}]).get(id).bytes.toString()
try {
 const page=await browser.newPage({viewport:{width:920,height:760},locale:'zh-CN'}),errors=[]
 page.on('pageerror',error=>{if(error.message!=='owned feature fixture: stop Host boot')errors.push(error.message)})
 await installOwnedViewPlatform(page,'source')
 await page.evaluate(()=>{
  document.documentElement.lang='zh-CN';document.body.innerHTML='<main style="max-width:760px;padding:28px;margin:auto"><h2>本轮生成的文件</h2><div id="files"></div></main>'
  window.__ModuleLoader__={load:value=>window.producedModule=value}
 })
 await page.addScriptTag({content:output})
 await page.evaluate(()=>{
  const api=producedModule.factory(id=>id==='@xharness/dsh-client-runtime/client'?{isAppendSurfaceEvent:e=>e.surface!=='replace'}:staticModules[id])
  window.paths=['/workspace/docs/报告.md','/workspace/report.pdf','/workspace/src/app.ts','/workspace/a/same.md','/workspace/b/same.md','/workspace/long/long-name-for-layout.png','/workspace/extra.txt']
  window.nativeCalls=[];window.previewCalls=[];window.inspectionCalls=[];window.copies=[];window.inspectMode=false;window.facts=undefined;
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>copies.push(text)}});
window.local=true;window.description={canOpenPath:true,canRevealPath:true};window.fail=false
  const dictionary={'produced.openIn':'Open in','produced.openInFile':'选择 {name} 的打开方式','produced.type.markdown':'Markdown','produced.type.pdf':'PDF document','produced.type.code':'Source code','produced.type.image':'Image','produced.type.website':'Website','produced.info':'文件信息','produced.infoFile':'{name} 的文件信息','produced.copyPath':'复制路径','produced.copied':'路径已复制','produced.copyFailed':'路径复制失败','produced.noPreview':'暂不支持内置预览','produced.tooLarge':'超过预览大小限制','produced.modifiedAt':'修改时间','produced.closeInfo':'收起信息','produced.created':'新建','produced.modified':'已修改','produced.remaining':'另有 {count} 个文件','produced.loadMore':'显示更多文件','produced.type.data':'Data file','produced.type.document':'Document','produced.type.presentation':'Presentation','produced.type.spreadsheet':'Spreadsheet','produced.label':'文件','produced.actions':'文件操作','produced.expand':'展开','produced.collapse':'收起','produced.preview':'内置预览','produced.external':'默认应用打开','produced.showInFolder':'在文件夹中显示','produced.open':'打开 {name}','produced.previewFile':'预览 {name}','produced.revealFile':'在文件夹中显示 {name}','produced.externalFile':'用默认应用打开 {name}','produced.moreOne':'+ 1 个文件','produced.more':'+ {count} 个文件'}
  const t=(key,values={})=>Object.entries(values).reduce((s,[k,v])=>s.replaceAll('{'+k+'}',v),dictionary[key]??key)
  window.root=ReactDOM.createRoot(document.getElementById('files'))
  window.renderFiles=()=>root.render(React.createElement(api.ProducedFiles,{matched:paths,openFile:path=>previewCalls.push(path),...(facts?{turn:{data:{get:()=>({produced:facts})}},seq:1000}:{}),resolveFilePath:path=>path.startsWith('/')?path:'/workspace/'+path,...(inspectMode?{inspectFile:async(path,revision,thumbnail,signal)=>{inspectionCalls.push({path,revision,thumbnail});await new Promise(resolve=>setTimeout(resolve,10));if(signal.aborted)throw new DOMException('Aborted','AbortError');return {path,bytes:2048,preview:path.endsWith('.png')?'image':'unsupported',...(path.endsWith('.png')?{width:640,height:320,thumbnail:{dataBase64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOQ67nzHwAE2AKGL5GjpgAAAABJRU5ErkJggg==',width:1,height:1}}:{})}}}:{}),isLoopback:local,useHostDescription:select=>select(description),openNativeFile:async(path,mode)=>{if(fail)throw Error('fixture opener failed');nativeCalls.push({path,mode})},t}))
  renderFiles()
 })
 const toggle=page.getByRole('button',{name:'文件操作',exact:true})
 const cards=page.locator('.iftpVG_card'),first=cards.first()
 const firstMenu=first.getByRole('button',{name:'选择 /workspace/docs/报告.md 的打开方式',exact:true})
 await firstMenu.waitFor();assert.equal(await cards.count(),1,'one visible card replaces the old chip/button row')
 assert.equal(await toggle.getAttribute('aria-expanded'),'false');assert.deepEqual(await page.evaluate(()=>nativeCalls),[])
 assert.equal(await page.getByRole('menuitem').count(),0,'actions stay in a dropdown, not a row of buttons')
 await toggle.click();assert.equal(await cards.count(),7)
 await first.getByRole('button',{name:'预览 /workspace/docs/报告.md',exact:true}).click()
 const menu=page.getByRole('menu')
 await firstMenu.click();await menu.getByRole('menuitem',{name:'在文件夹中显示',exact:true}).click();await menu.waitFor({state:'detached'})
 await firstMenu.click();await menu.getByRole('menuitem',{name:'默认应用打开',exact:true}).click();await menu.waitFor({state:'detached'})
 assert.deepEqual(await page.evaluate(()=>previewCalls),['/workspace/docs/报告.md'])
 assert.deepEqual(await page.evaluate(()=>nativeCalls),[{path:'/workspace/docs/报告.md',mode:'reveal'},{path:'/workspace/docs/报告.md',mode:'open'}])
 await page.evaluate(()=>window.fail=true);await firstMenu.click();await menu.getByRole('menuitem',{name:'默认应用打开',exact:true}).click();await page.getByRole('alert').getByText('fixture opener failed',{exact:true}).waitFor()
 await page.evaluate(()=>{local=false;renderFiles()});await firstMenu.click();assert.equal(await menu.getByRole('menuitem').count(),2);assert.equal(await menu.getByRole('menuitem',{name:'内置预览',exact:true}).count(),1);await page.keyboard.press('Escape');await menu.waitFor({state:'detached'})
 await page.evaluate(()=>{local=true;description={canOpenPath:true};renderFiles()});await firstMenu.click();assert.equal(await menu.getByRole('menuitem',{name:'默认应用打开',exact:true}).count(),1);assert.equal(await menu.getByRole('menuitem',{name:'在文件夹中显示',exact:true}).count(),0)
 await page.getByRole('heading',{name:'本轮生成的文件'}).click();await menu.waitFor({state:'detached'})
 await page.evaluate(()=>{description={canOpenPath:true,canRevealPath:true};fail=false;renderFiles()})
 await firstMenu.click();await menu.getByRole('menuitem',{name:'默认应用打开',exact:true}).click();await page.getByRole('alert').waitFor({state:'detached'})
 // Keyboard opens/focuses the owned menu; arrows/Home/End stay inside it.
 await firstMenu.focus();await page.keyboard.press('ArrowDown');await menu.waitFor();await page.waitForFunction(()=>document.activeElement?.getAttribute('role')==='menuitem')
 assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'内置预览')
 await page.keyboard.press('End');assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'复制路径')
 await page.keyboard.press('Home');assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'内置预览')
 await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'在文件夹中显示')
 await page.keyboard.press('Escape');await menu.waitFor({state:'detached'});assert.equal(await firstMenu.evaluate(element=>element===document.activeElement),true)
 await page.setViewportSize({width:460,height:780})
 const bounds=await first.boundingBox();assert.ok(bounds&&bounds.x+bounds.width<=460,'file card fits narrow chat column')
 for(const button of await first.locator('button').all()){const rect=await button.boundingBox();assert.ok(rect&&rect.x>=0&&rect.x+rect.width<=460,'no persistent action outside viewport')}
 // Portaled menus remain visible even for the last card in a scrolling chat.
 const lastMenu=cards.last().getByRole('button',{name:'选择 /workspace/extra.txt 的打开方式',exact:true});await lastMenu.click();await menu.waitFor();const menuBounds=await menu.boundingBox();assert.ok(menuBounds&&menuBounds.x>=0&&menuBounds.y>=0&&menuBounds.x+menuBounds.width<=460&&menuBounds.y+menuBounds.height<=780)
 const evidence=resolve('dist/regression/produced-files');mkdirSync(evidence,{recursive:true});await page.screenshot({path:resolve(evidence,engine+'-menu-narrow.png')})
 await page.keyboard.press('Escape');await page.setViewportSize({width:920,height:760});await page.screenshot({path:resolve(evidence,engine+'-expanded.png')})
 await toggle.click();assert.equal(await cards.count(),1);assert.equal(await toggle.getAttribute('aria-expanded'),'false')
 // A single HTML result has no redundant group heading/chips/expand control.
 await page.evaluate(()=>{paths=['/workspace/Web preview.html'];renderFiles()});await cards.first().getByText('Website',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'文件操作',exact:true}).count(),0)
 await page.setViewportSize({width:787,height:180})
 await page.evaluate(()=>{const main=document.querySelector('main');main.style.cssText='padding:35px 21px 0;max-width:none;margin:0';document.querySelector('h2').remove();document.querySelector('.iftpVG_root').style.marginTop='0'})
 await cards.first().screenshot({path:resolve(evidence,engine+'-reference-card.png')})
 await page.screenshot({path:resolve(evidence,engine+'-single.png')})
 await cards.first().getByRole('button',{name:'选择 /workspace/Web preview.html 的打开方式',exact:true}).click();await menu.waitFor();await menu.getByRole('menuitem',{name:'内置预览',exact:true}).click();assert.equal(await page.evaluate(()=>previewCalls.at(-1)),'/workspace/Web preview.html')
 // Office/PDF types get distinct semantic glyphs and colors, not play/checklist/paperclip fallbacks.
 await page.setViewportSize({width:787,height:600})
 await page.evaluate(()=>{paths=['/workspace/项目汇报.PPTX','/workspace/设计说明.DOCX','/workspace/数据分析.xlsx','/workspace/验收报告.pdf'];renderFiles()})
 await page.getByRole('button',{name:'文件操作',exact:true}).click()
 assert.deepEqual(await cards.evaluateAll(elements=>elements.map(element=>element.dataset.kind)),['presentation','document','spreadsheet','pdf'])
 const glyphs=await cards.locator('.iftpVG_icon svg').evaluateAll(elements=>elements.map(element=>element.innerHTML))
 assert.equal(new Set(glyphs).size,4,'four genuinely different glyphs, not color-only distinctions')
 const colors=await cards.locator('.iftpVG_icon').evaluateAll(elements=>elements.map(element=>getComputedStyle(element).color))
 assert.equal(new Set(colors).size,4)
 assert.deepEqual(await cards.locator('.iftpVG_meta small').allTextContents(),['Presentation','Document','Spreadsheet','PDF document'])
 await page.screenshot({path:resolve(evidence,engine+'-office-icons.png')})
 await page.setViewportSize({width:320,height:680})
 for(const card of await cards.all()){const rect=await card.boundingBox();assert.ok(rect&&rect.x>=0&&rect.x+rect.width<=320,'Office cards fit a 320px viewport')}
 const officeMenu=cards.nth(1).getByRole('button',{name:'选择 /workspace/设计说明.DOCX 的打开方式',exact:true})
 await officeMenu.click();await menu.getByRole('menuitem',{name:'默认应用打开',exact:true}).click();assert.deepEqual(await page.evaluate(()=>nativeCalls.at(-1)),{path:'/workspace/设计说明.DOCX',mode:'open'})
 // Unsupported cards reveal information rather than opening a failing preview.
 const before=await page.evaluate(()=>previewCalls.length)
 await cards.nth(1).getByRole('button',{name:'/workspace/设计说明.DOCX 的文件信息',exact:true}).click()
 await page.getByRole('region',{name:'/workspace/设计说明.DOCX 的文件信息',exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>previewCalls.length),before);assert.equal(await page.getByRole('alert').count(),0)
 await officeMenu.click();assert.equal(await menu.getByRole('menuitem',{name:'内置预览',exact:true}).count(),0);await menu.getByRole('menuitem',{name:'复制路径',exact:true}).click()
 assert.equal(await page.evaluate(()=>copies.at(-1)),'/workspace/设计说明.DOCX');await page.getByRole('status').getByText('路径已复制',{exact:true}).waitFor()
 // Repeated filenames expose their parent directories and only proven statuses.
 await page.setViewportSize({width:787,height:650})
 await page.evaluate(()=>{window.thumbnailUrls=new Set();const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);URL.createObjectURL=blob=>{const url=create(blob);thumbnailUrls.add(url);return url};URL.revokeObjectURL=url=>{thumbnailUrls.delete(url);revoke(url)};inspectMode=true;paths=['/workspace/a/same.docx','/workspace/b/same.docx','/workspace/figure.png'];facts=[{path:paths[0],seq:2,change:'created'},{path:paths[1],seq:3,change:'modified'},{path:paths[2],seq:4}];renderFiles()})
 await cards.nth(0).getByText('Document · 2 KB',{exact:true}).waitFor()
 assert.deepEqual(await cards.locator('.iftpVG_parent').allTextContents(),['/workspace/a','/workspace/b'])
 assert.deepEqual(await cards.locator('.iftpVG_badge').allTextContents(),['新建','已修改'])
 await cards.nth(2).getByText('Image · 2 KB · 640 × 320',{exact:true}).waitFor();await cards.nth(2).locator('img').waitFor()
 const used=await cards.nth(2).locator('img').getAttribute('src');assert.ok(used.startsWith('blob:'));assert.equal(await page.evaluate(url=>thumbnailUrls.has(url),used),true)
 await page.screenshot({path:resolve(evidence,engine+'-metadata-thumbnails.png')})
 // Folded rows are not mounted/read. Pagination bounds a large expanded set.
 await page.getByRole('button',{name:'文件操作',exact:true}).click();assert.equal(await cards.count(),1);await page.waitForFunction(url=>!thumbnailUrls.has(url),used)
 await page.evaluate(()=>{inspectionCalls=[];facts=undefined;paths=Array.from({length:85},(_,i)=>'/workspace/sample'+i+'.docx');renderFiles()})
 await cards.first().getByText('Document · 2 KB',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>inspectionCalls.length),1)
 await page.getByRole('button',{name:'文件操作',exact:true}).click();assert.equal(await cards.count(),20)
 await page.getByRole('button',{name:'显示更多文件',exact:true}).click();assert.equal(await cards.count(),40)
 await page.getByRole('button',{name:'文件操作',exact:true}).click();assert.equal(await cards.count(),1)
 assert.deepEqual(errors,[])
 console.log(JSON.stringify({engine,sourceComponent:true,expandAll:true,exactPathActions:true,noAutomaticNativeOpen:true,localCapabilityGuard:true,legacyHostGuard:true,errorFeedback:true,narrowLayout:true,fold:true,dropdown:true,keyboard:true,portalBounds:true,singleCard:true,officeIcons:true,office320px:true,metadata:true,thumbnails:true,copyPath:true,truthfulStatus:true,pagination:true,errors}))
} finally {await browser.close()}
