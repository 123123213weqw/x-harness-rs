/** Actual compiled feature/React, controlled transport; never a live-review claim. */
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import {installOwnedViewHtml} from './fixtures/owned-view-platform-browser.mjs'
import {compileSourceModules} from './build-source-modules.mjs'
const require=createRequire(resolve(process.env.UI_TEST_DEPS??'/Users/wangyue/codex-build/xharness-plugin-migration/ui-browser-deps','package.json'))
const {chromium,webkit}=require('playwright'),engine=process.env.UI_TEST_BROWSER??'chromium',browser=await({chromium,webkit}[engine]).launch({headless:true})
const source=compileSourceModules(new URL('../ui',import.meta.url).pathname,[{id:'@xlang/xharness-client-ui-code-review',source:'src/modules/code-review/index.tsx'},{id:'@xharness/dsh-client-ui-conversation',source:'src/modules/conversation/index.ts'}]).get('@xlang/xharness-client-ui-code-review').bytes.toString()
try{
 const page=await browser.newPage({viewport:{width:1360,height:850}}),errors=[];page.on('pageerror',e=>{if(e.message!=='owned feature fixture: stop Host boot')errors.push(e.message)})
 await installOwnedViewHtml(page,'source','<html lang="en"><head></head><body style="margin:0"><div id="root" style="position:fixed;inset:0"></div></body></html>',{origin:'https://review-p0.test'})
 await page.addScriptTag({content:'window.__ModuleLoader__={load:row=>{window.registration=row}}'});await page.addScriptTag({content:source})
 await page.evaluate(()=>{
  window.head='a'.repeat(40);window.runs=[];window.calls=[];window.outcome='complete'
  const detail=()=>({id:7,repository:'alice/project',author:'alice',title:'Review test',updatedAt:'2026-10-04T00:00:00Z',state:'open',draft:false,headSha:head,branch:'topic',baseBranch:'master',body:'PR description',additions:1,deletions:1,changedFiles:1,mergeable:true,mergeableState:'clean',files:[{path:'a.rs',status:'modified',additions:1,deletions:1,patch:'@@ -1,2 +1,2 @@\n context\n-old\n+new'}],comments:[],reviews:[],checks:[],filesHasMore:false,commentsHasMore:false,reviewsHasMore:false,checksTruncated:false,inlineCommentCount:1,commentCount:0})
  const rpc={call:async(_channel,method,{args})=>{calls.push({method,args});let value
   if(method==='github/auth')value={account:'alice',source:'github-cli'}
   else if(method==='github/repos')value={items:['alice/project'],hasMore:false}
   else if(method==='github/pulls')value={items:[detail()],hasMore:false}
   else if(method==='github/detail')value=detail()
   else if(method==='github/threads')value={items:[{id:'t1',path:'a.rs',side:'right',line:2,startLine:null,resolved:false,outdated:false,comments:{items:[{id:'c1',author:'reviewer',body:'Initial discussion',createdAt:'2026-10-04T00:00:00Z',url:'https://github.com/alice/project/pull/7'}],hasMore:true,cursor:'next'}}],hasMore:false,cursor:null}
   else if(method==='github/thread-comments')value={items:[{id:'c2',author:'alice',body:'Actual reply',createdAt:'2026-10-04T00:00:00Z',url:'https://github.com/alice/project/pull/7'}],hasMore:false,cursor:null}
   else if(method==='github/runs')value={items:[{id:9,name:'CI',status:'completed',conclusion:'failure',headSha:head,attempt:1,mergeTest:false}],hasMore:false}
   else if(method==='github/jobs')value={items:[{id:10,name:'Rust tests',status:'completed',conclusion:'failure',steps:[{number:1,name:'Unit tests',status:'completed',conclusion:'failure'}]}],hasMore:false}
   else if(method==='github/logs')value={text:'assertion failed: expected 42',truncated:true}
   else if(method==='github/review-models')value={items:[{provider:'p',model:'model',name:'Test model'}]}
   else if(method==='github/review-history')value={items:runs}
   else if(method==='github/review-start'){
    const d=detail(),snapshot={account:'alice',repository:d.repository,number:d.id,headSha:d.headSha,files:d.files,filesHasMore:false,changedFiles:1}
    value={id:`r${runs.length}`,target:{account:'alice',repository:d.repository,number:d.id,sha:d.headSha},provider:'p',model:'model',mode:args.mode,question:args.question,status:'running',text:'',snapshot,error:null,stale:false};runs.unshift(value)
   }else if(method==='github/review-status'){
    const old=runs.find(r=>r.id===args.id);value={...old,status:outcome==='cancel'?'cancelled':outcome==='fail'?'failed':'completed',error:outcome==='fail'?'Stream interrupted':null,text:old.mode==='question'?'Actual PR answer':JSON.stringify({version:1,findings:[{priority:1,title:'Fixture finding',explanation:'Trigger and consequence',path:'a.rs',side:'right',startLine:2,endLine:2,evidence:'new'}]})};runs=runs.map(r=>r.id===value.id?value:r)
   }else if(method==='github/review-cancel'){outcome='cancel';value=runs.find(r=>r.id===args.id)}
   else throw Error(method)
   return {ok:true,value}
  }}
  const feature=registration.factory(id=>{if(id in staticModules)return staticModules[id];throw Error(id)}),root=ReactDOM.createRoot(document.getElementById('root'));let Component,props
  feature.apply({get:name=>name==='connection'?{rpc}:name==='sessions'?{list:{getSnapshot:()=>({ids:[],byId:{}}),subscribe:()=>()=>{}}}:name==='workspaces'?{list:{getSnapshot:()=>({items:[]}),subscribe:()=>()=>{}}}:{input:{}},effect:(fn,label)=>{if(!label.includes('idle'))fn()},slots:{inject:(_name,fn)=>fn(),register:(spec,component)=>{if(spec.name==='review.center'){Component=component;props=spec.inject()}}}})
  window.mount=()=>root.render(React.createElement(Component,{...props,close:()=>root.render(null)}));window.unmount=()=>root.render(null);mount()
 })
 await page.getByRole('button',{name:/Review test/}).click();await page.getByRole('heading',{name:'Review test',exact:true}).waitFor()
 await page.getByRole('button',{name:'Load discussions',exact:true}).click();await page.locator('.xhreview-thread summary').click();await page.getByText('Initial discussion',{exact:true}).waitFor();await page.getByRole('button',{name:'More replies'}).click();await page.getByText('Actual reply',{exact:true}).waitFor();await page.getByRole('button',{name:'Show code'}).click();assert.equal(await page.getByRole('tab',{name:/Changes/}).getAttribute('aria-selected'),'true');await page.locator('[data-side="right"][data-line="2"]').waitFor();assert.equal(await page.locator('.xhreview-line-number').first().evaluate(node=>getComputedStyle(node).display),'inline-block')
 await page.getByRole('button',{name:'Load jobs and steps'}).click();await page.locator('.xhreview-workflow summary').first().click();await page.getByText('Rust tests · failure',{exact:true}).click();await page.getByText('Unit tests · failure',{exact:true}).waitFor();await page.getByRole('button',{name:'Load logs'}).click();await page.getByText('assertion failed: expected 42',{exact:true}).waitFor();await page.getByText('Log exceeds the display bound; content is incomplete.',{exact:true}).waitFor()
 await page.getByRole('tab',{name:'Review',exact:true}).click();await page.getByRole('button',{name:'Review changes',exact:true}).click();await page.getByRole('heading',{name:/Fixture finding/}).waitFor();await page.getByText('AI findings · Needs confirmation',{exact:false}).waitFor();assert.equal(await page.getByText('safe to merge',{exact:false}).count(),0)
 await page.getByRole('button',{name:'a.rs:2 · right'}).click();assert.equal(await page.getByRole('tab',{name:/Changes/}).getAttribute('aria-selected'),'true')
 await page.getByRole('tab',{name:'Review',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'Ask about this PR'}).count(),0)
 await page.evaluate(()=>outcome='fail');await page.getByRole('button',{name:'Review changes',exact:true}).click();await page.getByText('Stream interrupted',{exact:true}).waitFor()
 await page.evaluate(()=>head='b'.repeat(40));await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('tab',{name:'Review',exact:true}).click();await page.getByText('This result is stale or current head could not be verified. Review again.',{exact:true}).waitFor()
 assert.deepEqual(errors,[]);console.log(JSON.stringify({engine,threadsAndReplies:true,lineJump:true,jobsStepsLogs:true,structuredFinding:true,structuredReview:true,failureNotPass:true,shaStale:true,pageErrors:errors}))
}finally{await browser.close()}
