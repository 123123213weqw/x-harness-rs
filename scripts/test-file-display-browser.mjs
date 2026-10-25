import {fixtureUiRoot} from './fixtures/ui-fixture-build.mjs'
// Full shipped owned UI graph; only the Host fixture transport is substituted.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {readFileSync,existsSync,mkdirSync} from 'node:fs'
import {resolve,sep,extname} from 'node:path'
const require=createRequire(resolve(process.env.UI_TEST_DEPS??'/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps','package.json'))
const engine=process.env.UI_TEST_BROWSER??'chromium',browser=await require('playwright')[engine].launch({headless:true}),base=fixtureUiRoot()
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOQ67nzHwAE2AKGL5GjpgAAAABJRU5ErkJggg=='
const patch='diff --git a/main.rs b/main.rs\n--- a/main.rs\n+++ b/main.rs\n@@ -1,2 +1,2 @@\n fn main() {\n-old();\n+new();\ndiff --git a/image.png b/image.png\nindex a..b 100644\nBinary files a/image.png and b/image.png differ\n'
let version=1
try{
 const page=await browser.newPage({viewport:{width:1400,height:900},locale:'zh-CN'}),errors=[],reads=[],externalRequests=[]
 page.setDefaultTimeout(20000);page.on('pageerror',e=>{errors.push(e.message);console.error('PAGEERROR',e.message)})

 await page.route('**/*',async route=>{
  const url=new URL(route.request().url())
  if(url.protocol==='blob:')return route.continue()
  if(url.pathname==='/api/display/inspect'){
   const args=route.request().postDataJSON().payload
   const preview=/\.(?:docx|xlsx|pptx|zip)$/i.test(args.path)?'unsupported':'text'
   return route.fulfill({contentType:'application/json',body:JSON.stringify({type:'server-response',rpcId:route.request().postDataJSON().rpcId,result:{ok:true,value:{path:'/workspace/'+args.path.replace(/^\/workspace\//,''),bytes:2048,preview}}})})
  }
  if(url.pathname==='/api/display/read'){
   const request=route.request().postDataJSON(),args=request.payload;reads.push(args)
   let value
   if(args.gitDiff)value={kind:'diff',path:'/workspace',source:args.gitDiff,text:args.gitDiff==='head'?'':patch}
   else if(args.path.endsWith('large.patch'))value={kind:'diff',path:'/workspace/large.patch',source:'patch',text:'--- a/large.rs\n+++ b/large.rs\n@@ -0,0 +1,7000 @@\n'+'+long line\n'.repeat(7000)}
   else if(args.path.endsWith('bad.patch'))value={kind:'diff',path:'/workspace/bad.patch',source:'patch',text:'--- a/main.rs\n+++ b/main.rs\n@@ -1,2 +1,2 @@\n-old\n+new\n'}
   else if(args.path.endsWith('change.patch'))value={kind:'diff',path:'/workspace/change.patch',source:'patch',text:patch}
   else if(args.path.endsWith('report.md'))value={kind:'markdown',path:'/workspace/docs/report.md',text:`# Report v${version}\n\n| Name | Result |\n|---|---|\n| Preview | OK |\n\n$$x^2+y^2=z^2$$\n\n![Local figure](../figure.png)\n\n[Open code](../main.rs)\n\n<script>window.executed=true</script>\n`}
   else if(args.path.endsWith('figure.png'))value={kind:'image',path:'/workspace/figure.png',mediaType:'image/png',dataBase64:png,width:1,height:1}
   else if(args.path.endsWith('report.pdf'))value={kind:'pdf',path:'/workspace/report.pdf',dataBase64:Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64')}
   else if(args.path.endsWith('page.html'))value={kind:'text',path:'/workspace/page.html',text:'<h1>Local HTML</h1><style>h1{color:rgb(22,88,44)}</style><script>parent.executed=true</script><img src="https://outside.invalid/tracker"><iframe src="https://outside.invalid/frame"></iframe><meta http-equiv="refresh" content="0;url=https://outside.invalid/nav"><a href="https://outside.invalid/nav">No navigation</a>'}
   else if(args.path.endsWith('main.rs'))value={kind:'text',path:'/workspace/main.rs',text:'fn main() { println!("Preview"); }'}
   else return route.fulfill({json:{type:'server-response',rpcId:request.rpcId,result:{ok:false,error:{code:'bad-request',message:'file not found',details:[]}}}})
   return route.fulfill({json:{type:'server-response',rpcId:request.rpcId,result:{ok:true,value}}})
  }
  if(url.hostname!=='127.0.0.1'){externalRequests.push(url.href);return route.abort()}
  const path=resolve(base,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname))
  if(!path.startsWith(base+sep)||!existsSync(path))return route.fulfill({status:404,body:'missing fixture asset'})
  let body=readFileSync(path)
  if(url.pathname==='/plugins/@xharness/dsh-client-connection/client.js'){
   const marker='hostConns.add(conn);',text=body.toString();assert.equal(text.split(marker).length,2,'unique original Host stream fixture seam')
   const rpcMarker='call(channel, endpoint, payload) {'
   assert.equal(text.split(rpcMarker).length,2,'unique in-memory RPC fixture seam')
   body=Buffer.from(text.replace(marker,marker+'\nwindow.emitFileDisplay = intent => conn.push({rpcId: mint(), payload:{type:"host/remote-event",event:"display/open",args:[intent]}});').replace(rpcMarker,rpcMarker+'\nif(endpoint==="display/read"||endpoint==="display/inspect")return fetch("/api/"+endpoint,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({rpcId:"fixture-display",payload}),signal:arguments[3]}).then(response=>response.json()).then(response=>response.result);'))
  }
  const type={'.html':'text/html','.js':'application/javascript','.json':'application/json','.css':'text/css','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.wasm':'application/wasm','.svg':'image/svg+xml'}
  return route.fulfill({body,contentType:type[extname(path)]??'application/octet-stream'})
 })
 await page.goto('http://127.0.0.1:39188/?fixture=1');
 await page.getByText('Fixture 历史会话',{exact:true}).waitFor({timeout:20000});await page.locator('[data-xh-startup-exit]').waitFor({state:'detached'});await page.getByText('Fixture 历史会话',{exact:true}).click();await page.waitForFunction(()=>typeof window.emitFileDisplay==='function')
 await page.evaluate(()=>{window.blobs=new Set();const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);URL.createObjectURL=blob=>{const url=create(blob);blobs.add(url);return url};URL.revokeObjectURL=url=>{blobs.delete(url);revoke(url)}})
 // Actual host event → remote dispatch → model-open adapter → same file tab.
 await page.evaluate(()=>{window.fileIntents=[];window.addEventListener('xharness:workspace-open',e=>fileIntents.push(e.detail));emitFileDisplay({sessionId:'fx-alpha',path:'/workspace/docs/report.md'})})

 const pane=page.getByRole('region',{name:'文件预览'});await pane.getByRole('heading',{name:'Report v1'}).waitFor()
 await pane.locator('table').waitFor();await pane.locator('.katex').first().waitFor();await pane.locator('img').waitFor();await pane.locator('img').evaluate(img=>img.decode());assert.ok(reads.some(r=>r.path==='../figure.png'&&r.relativeTo==='/workspace/docs/report.md'&&r.sessionId==='fx-alpha'))
 assert.equal(await page.evaluate(()=>window.executed),undefined);assert.equal(await page.locator('.xhworkspace-body script').count(),0)
 const count=await page.locator('.xhworkspace-tab').count();await page.evaluate(()=>emitFileDisplay({sessionId:'fx-alpha',path:'/workspace/docs/report.md'}));assert.equal(await page.locator('.xhworkspace-tab').count(),count,'same file reuses its tab')
 const markdownUrl=await pane.locator('img').getAttribute('src');await pane.getByRole('button',{name:'源码',exact:true}).click();await pane.locator('pre').waitFor();await page.waitForFunction(url=>!blobs.has(url),markdownUrl);await pane.getByRole('button',{name:'预览',exact:true}).click();await pane.locator('img').waitFor()
 version=2;await pane.getByRole('button',{name:'刷新文件',exact:true}).click();await pane.getByRole('heading',{name:'Report v2'}).waitFor();await pane.locator('img').evaluate(img=>img.decode())
 const markdownEvidence=resolve('dist/regression/file-display');mkdirSync(markdownEvidence,{recursive:true});await page.screenshot({path:resolve(markdownEvidence,engine+'-markdown.png')})
 const refreshedUrl=await pane.locator('img').getAttribute('src');await pane.getByRole('button',{name:'Open code',exact:true}).click();await pane.locator('pre').waitFor();assert.ok(reads.some(r=>r.path==='../main.rs'&&r.relativeTo==='/workspace/docs/report.md'));await page.waitForFunction(url=>!blobs.has(url),refreshedUrl)
 await page.evaluate(()=>emitFileDisplay({sessionId:'fx-alpha',path:'/workspace/figure.png'}));await pane.locator('.xhfile-image img').waitFor();await pane.locator('.xhfile-image img').evaluate(img=>img.decode());const imageUrl=await pane.locator('.xhfile-image img').getAttribute('src');assert.equal(await page.evaluate(url=>blobs.has(url),imageUrl),true)
 await pane.getByRole('button',{name:'放大',exact:true}).click();await pane.getByRole('button',{name:'125%',exact:true}).waitFor()
 const evidence=resolve('dist/regression/file-display');mkdirSync(evidence,{recursive:true});await page.screenshot({path:resolve(evidence,engine+'-image.png')})
 await page.getByRole('button',{name:'收起右侧工作区',exact:true}).click();await pane.waitFor({state:'hidden'});await page.waitForFunction(url=>!blobs.has(url),imageUrl);await page.getByRole('button',{name:'展开右侧工作区',exact:true}).click();await pane.locator('.xhfile-image img').waitFor();const reopenedUrl=await pane.locator('.xhfile-image img').getAttribute('src')
 await page.getByRole('button',{name:'关闭 figure.png',exact:true}).click();await pane.locator('pre').waitFor();await page.waitForFunction(url=>!blobs.has(url),refreshedUrl)
 await page.evaluate(()=>emitFileDisplay({sessionId:'fx-beta',path:'/workspace/docs/report.md'}));await page.waitForTimeout(100);assert.ok(await pane.locator('pre').count()>0,'background intent does not steal foreground pane')
 await page.evaluate(()=>emitFileDisplay({sessionId:'fx-alpha',path:'/workspace/change.patch'}));
 const diff=pane.getByRole('region',{name:'差异预览'});await diff.locator('.xhfile-diff-row[data-kind="added"]').waitFor();assert.equal(await diff.locator('.xhfile-diff-row[data-kind="removed"]').count(),1)
 await diff.getByRole('button',{name:'左右对照',exact:true}).click();await diff.locator('.xhfile-diff-row[data-split]').first().waitFor();await page.screenshot({path:resolve(evidence,engine+'-diff.png')});await diff.screenshot({path:resolve(evidence,engine+'-diff-panel.png')});const cells=diff.locator('.xhfile-diff-row[data-split]').last().locator('.xhfile-diff-cell');assert.equal(await cells.count(),2);const bounds=await cells.nth(1).boundingBox(),paneBounds=await pane.boundingBox();assert.ok(bounds&&paneBounds&&bounds.x+bounds.width<=paneBounds.x+paneBounds.width+1,'small split diff fits inside the dock')
 await diff.locator('.xhfile-diff-files button').nth(1).click();await diff.getByText('二进制文件变更，无文本差异',{exact:true}).waitFor()
 await diff.getByRole('button',{name:'源码',exact:true}).click();assert.ok((await diff.locator('pre').textContent()).includes('diff --git'))
 await page.evaluate(()=>emitFileDisplay({sessionId:'fx-alpha',path:'/workspace/large.patch'}));await diff.locator('.xhfile-diff-scroll').waitFor();assert.ok(await diff.locator('.xhfile-diff-row').count()<100,'large diffs do not mount every row')
 await diff.locator('.xhfile-diff-scroll').evaluate(element=>element.scrollTop=element.scrollHeight);await page.waitForTimeout(100);assert.ok(await diff.locator('.xhfile-diff-row').count()<100);assert.ok((await diff.locator('.xhfile-diff-scroll').textContent()).includes('7000'),'last row stays accessible')
 await page.evaluate(()=>emitFileDisplay({sessionId:'fx-alpha',path:'/workspace',gitDiff:'working'}));await pane.getByRole('combobox',{name:'差异范围'}).waitFor();await diff.getByText('未暂存 · 对比索引',{exact:true}).waitFor();assert.ok(reads.some(r=>r.gitDiff==='working'&&r.sessionId==='fx-alpha'))
 const gitCount=await page.locator('.xhworkspace-tab').count();await page.evaluate(()=>emitFileDisplay({sessionId:'fx-alpha',path:'/workspace',gitDiff:'working'}));assert.equal(await page.locator('.xhworkspace-tab').count(),gitCount)
 await pane.getByRole('combobox',{name:'差异范围'}).selectOption('staged');await diff.getByText('已暂存 · 对比 HEAD',{exact:true}).waitFor();assert.ok(reads.some(r=>r.gitDiff==='staged'))
 await pane.getByRole('combobox',{name:'差异范围'}).selectOption('head');await diff.getByRole('status').getByText('此范围没有差异',{exact:true}).waitFor();assert.ok(reads.some(r=>r.gitDiff==='head'))
 await page.evaluate(()=>emitFileDisplay({sessionId:'fx-alpha',path:'/workspace/bad.patch'}));await diff.getByRole('alert').waitFor();assert.ok((await diff.locator('pre').textContent()).includes('@@ -1,2 +1,2 @@'),'malformed patch retains complete raw source')
 const beforeInvalid=await page.locator('.xhworkspace-tab').count();await page.evaluate(()=>emitFileDisplay({sessionId:'fx-alpha',path:'.',gitDiff:'shell'}));await page.waitForTimeout(50);assert.equal(await page.locator('.xhworkspace-tab').count(),beforeInvalid)
 await page.evaluate(()=>emitFileDisplay({sessionId:'fx-alpha',path:'/workspace/missing.md'}));await pane.getByRole('alert').waitFor();await pane.getByRole('button',{name:'默认应用打开',exact:true}).waitFor();await pane.locator('summary').click();await pane.getByText('file not found',{exact:true}).waitFor()
 await page.evaluate(()=>emitFileDisplay({sessionId:'fx-alpha',path:'/workspace/page.html'}));
 const htmlFrame=pane.locator('iframe[title="HTML 预览"]');await htmlFrame.waitFor();assert.equal(await htmlFrame.getAttribute('sandbox'),'');
 await page.frameLocator('iframe[title="HTML 预览"]').getByRole('heading',{name:'Local HTML'}).waitFor();
 assert.equal(await page.frameLocator('iframe[title="HTML 预览"]').locator('script,iframe,meta[http-equiv="refresh"],a[href],img[src]').count(),0)
 assert.equal(await page.evaluate(()=>window.executed),undefined);assert.deepEqual(externalRequests,[])
 await pane.getByRole('button',{name:'源码',exact:true}).click();await pane.locator('pre').waitFor();assert.ok((await pane.locator('pre').textContent()).includes('parent.executed'))
 await page.evaluate(()=>emitFileDisplay({sessionId:'fx-alpha',path:'/workspace/report.pdf'}));
 const pdfFrame=pane.locator('iframe[title="PDF 预览"]');await pdfFrame.waitFor();const pdfUrl=await pdfFrame.getAttribute('src');assert.equal(await page.evaluate(url=>blobs.has(url),pdfUrl),true)
 await page.getByRole('button',{name:'关闭 report.pdf',exact:true}).click();await page.waitForFunction(url=>!blobs.has(url),pdfUrl)
 assert.equal(await pane.getByRole('button',{name:'默认应用打开',exact:true}).count(),1);assert.equal(await pane.getByRole('button',{name:'在文件夹中显示',exact:true}).count(),1)
 assert.deepEqual(errors,[]); await page.evaluate(()=>window.emitFileDisplay({sessionId:'fx-alpha',path:'/workspace/deck.docx'}))
 await page.getByText('此格式暂不支持内置预览。',{exact:true}).waitFor();await pane.getByText('2 KB',{exact:true}).waitFor()
 await page.evaluate(()=>{window.clipboardWrites=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>clipboardWrites.push(text)}})})
 await pane.getByRole('button',{name:'复制路径',exact:true}).click();await pane.getByRole('button',{name:'路径已复制',exact:true}).waitFor();assert.equal(await page.evaluate(()=>clipboardWrites.at(-1)),'/workspace/deck.docx')
 assert.deepEqual(errors,[])
 assert.equal(reads.some(row=>row.path==='/workspace/deck.docx'),false,'unsupported Office files never enter full display/read')
console.log(JSON.stringify({engine,fullOwnedGraph:true,modelHostFrame:true,markdown:true,math:true,relativeImages:true,code:true,refresh:true,imageZoom:true,reuse:true,patchDiff:true,gitScopes:true,largeDiffWindow:true,malformedSourceFallback:true,blobCleanup:true,backgroundIsolation:true,htmlIsolation:true,pdfBlobLifecycle:true,nativeActions:true,errors}))
}finally{await browser.close()}
