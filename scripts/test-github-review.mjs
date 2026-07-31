/** Typed wire parsers and adversarial request ordering; no credentials/models. */
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import vm from 'node:vm'
const require=createRequire(new URL('../ui/package.json',import.meta.url));const {buildSync}=require('esbuild')
function load(path){const module={exports:{}};vm.runInNewContext(buildSync({entryPoints:[new URL(path,import.meta.url).pathname],bundle:true,write:false,format:'cjs',platform:'node'}).outputFiles[0].text,{module,exports:module.exports,AbortController,Date,Set,Map,URL,setTimeout,clearTimeout});return module.exports}
const client=load('../ui/src/modules/code-review/client.ts'),data=load('../ui/src/modules/code-review/data.ts')
const {ReviewCache}=load('../ui/src/modules/code-review/cache.ts')
const record={id:7,repository:'alice/project',title:'read-only PR',author:'alice',updatedAt:'2026-10-04T00:00:00Z',state:'open',draft:false,headSha:'a'.repeat(40),branch:'topic',body:'<script>nothing runs</script>',baseBranch:'master',additions:3,deletions:1,changedFiles:2,mergeable:null,mergeableState:'unknown',files:[{path:'image.png',status:'added',patch:null,additions:0,deletions:0}],comments:[],reviews:[],checks:[{id:'check:1',name:'CI',status:'in_progress',conclusion:null,description:''}],filesHasMore:false,commentsHasMore:false,reviewsHasMore:false,checksTruncated:false,inlineCommentCount:0,commentCount:0}
test('strict decoder preserves unknown mergeability, missing binary patch and pending CI',()=>{const v=client.detail(record);assert.equal(v.mergeable,null);assert.equal(v.files[0].patch,null);assert.equal(data.checkState(v.checks[0]),'pending')})
test('invalid fields, contradictory envelope, invalid dates and coercions are rejected',()=>{
 for(const [field,value] of [['id','7'],['files',{}],['mergeable','true'],['additions',-1],['updatedAt','oops'],['checks',null],['body',null],['headSha',42]])assert.throws(()=>client.detail({...record,[field]:value}),/Invalid GitHub response/)
 for(const value of [{ok:'true',value:record},{ok:true,error:{},value:record},{ok:false},{ok:true}])assert.throws(()=>client.detail(client.unwrap(value)))
})
test('remote error kinds remain actionable without exposing credentials',()=>{for(const kind of ['authentication','permission','rate_limit','head_changed','account_changed','timeout'])assert.throws(()=>client.unwrap({ok:false,error:{code:'internal',message:'safe message',details:{kind}}}),e=>e.kind===kind)})
test('read client uses the existing channel, envelope and AbortSignal',async()=>{const seen=[];const signal=new AbortController().signal;const api=new client.GitHubClient({call:async(...args)=>{seen.push(args);return {ok:true,value:record}}});await api.detail('alice','alice/project',7,signal);assert.equal(seen[0][0],'/api');assert.equal(seen[0][1],'github/detail');assert.equal(seen[0][2].args.number,7);assert.equal(seen[0][3],signal)})
test('pending, cancelled, neutral and unknown conclusions are never shown as passing',()=>{for(const [status,conclusion,expected] of [['queued',null,'pending'],['in_progress','success','pending'],['completed','success','passed'],['completed','failure','failed'],['completed','cancelled','failed'],['completed','skipped','neutral'],['completed','future','neutral'],['completed',null,'neutral']])assert.equal(data.checkState({status,conclusion}),expected)})
test('new selections and unmount invalidate older successes and failures even without transport abort',async()=>{const lane=new data.RequestLane();const first=lane.start(),second=lane.start();assert.equal(first.signal.aborted,true);assert.equal(first.current(),false);assert.equal(second.current(),true);lane.cancel();assert.equal(second.current(),false);assert.equal(second.signal.aborted,true)})
test('PR links require exact HTTPS repository and safe positive integer',()=>{assert.equal(data.parsePullLink('https://github.com/alice/project/pull/7').id,7);for(const url of ['http://github.com/alice/project/pull/7','https://evil.com/alice/project/pull/7','https://github.com/alice/project/pull/0','https://github.com/alice/project/pull/9007199254740992','https://github.com/alice/../pull/7?x=1'])assert.equal(data.parsePullLink(url),null);assert.equal(data.filterPulls([record],'PROJECT',null).length,1);assert.equal(data.filterPulls([record],'','bob').length,0)})
test('feature uses pinned GET HTTP and never exposes credentials to UI/model storage',()=>{
 const ui=readFileSync(new URL('../ui/src/modules/code-review/index.tsx',import.meta.url),'utf8')
 for(const forbidden of ['localStorage','dangerouslySetInnerHTML','records,','Preview data','Merge</button>','credentials.set','auth token'])assert.ok(!ui.includes(forbidden),forbidden)
 const native=readFileSync(new URL('../crates/xharness-host-app/src/github_service.rs',import.meta.url),'utf8')
 const http=readFileSync(new URL('../crates/xharness-host-app/src/github_http.rs',import.meta.url),'utf8')
 assert.ok(http.includes('.get(url)'));assert.ok(http.includes('redirect(reqwest::redirect::Policy::none())'))
 assert.ok(http.includes('"auth", "token", "--hostname", "github.com"'));assert.ok(http.includes('["--user", account]'))
 assert.ok(http.includes('set_sensitive(true)'));assert.ok(http.includes('kill_on_drop(true)'))
 assert.ok(http.includes('bounded_read_limit(stdout, 4096)'));assert.ok(!http.includes('"api",'))
 assert.ok(native.includes('"head_changed"'));assert.ok(http.includes('"account_changed"'));assert.match(native,/self\.reader\s*\.session\(/)
})
if(process.env.XHARNESS_GITHUB_WIRE_FIXTURE)test('real Rust serde envelope is accepted by the strict frontend decoder',()=>{const envelope=JSON.parse(readFileSync(process.env.XHARNESS_GITHUB_WIRE_FIXTURE,'utf8'));const result=client.detail(client.unwrap(envelope));assert.equal(result.headSha,'a'.repeat(40));assert.equal(result.mergeable,null);assert.equal(result.files[1].patch,null)})

test('warm cache retains stale data without extending freshness and fences account/head',()=>{
 let clock=0;const cache=new ReviewCache(()=>clock),page={items:[record],hasMore:false}
 cache.putBootstrap({account:'alice',source:'github-cli'},{items:['alice/project'],hasMore:false});cache.putList('alice','alice/project',page);cache.putDetail('alice',record)
 assert.equal(cache.bootstrap('bob'),undefined);assert.equal(cache.list('bob','alice/project'),undefined);assert.equal(cache.detail('bob',record),undefined)
 assert.equal(cache.detail('alice',record,'a'.repeat(40)).id,7)
 assert.equal(cache.detail('alice',record,'b'.repeat(40)),undefined)
 cache.putDetail('alice',record);clock=30_000;assert.equal(cache.detail('alice',record).id,7);assert.equal(cache.detailFresh('alice',record),false)
 assert.equal(cache.bootstrap('alice').identity.account,'alice');clock=60_000
 assert.equal(cache.bootstrapFresh('alice'),false);assert.equal(cache.listFresh('alice','alice/project'),false);assert.equal(cache.list('alice','alice/project').items.length,1);clock=24*60*60*1000+60_000;assert.equal(cache.bootstrap('alice'),undefined);assert.equal(cache.list('alice','alice/project'),undefined)
})
test('warm cache bounds LRU entries and detail bytes',()=>{
 const cache=new ReviewCache(()=>0)
 for(let id=1;id<=3;id++)cache.putDetail('alice',{...record,id})
 cache.detail('alice',{...record,id:1});cache.putDetail('alice',{...record,id:4})
 assert.equal(cache.detail('alice',{...record,id:2}),undefined);assert.equal(cache.detail('alice',{...record,id:1}).id,1)
 cache.putDetail('alice',{...record,id:5,body:'x'.repeat(2*1024*1024)})
 assert.equal(cache.detail('alice',{...record,id:5}),undefined)
 for(let id=1;id<=4;id++)cache.putList('alice',`alice/repo${id}`,{items:[],hasMore:false})
 assert.equal(cache.list('alice','alice/repo1'),undefined)
 cache.clear();assert.equal(cache.detail('alice',{...record,id:1}),undefined)
})
test('clearing cancels warmup even if transport ignores abort and returns late',async()=>{
 const cache=new ReviewCache(()=>0);let finish,signal
 const fake={auth:async(s)=>{signal=s;return new Promise(resolve=>{finish=resolve})},repos:async()=>({items:['alice/project'],hasMore:false}),pulls:async()=>({items:[record],hasMore:false})}
 cache.warm(fake);cache.clear();assert.equal(signal.aborted,true);finish({account:'alice',source:'github-cli'})
 await new Promise(resolve=>setTimeout(resolve,0));assert.equal(cache.bootstrap('alice'),undefined);assert.equal(cache.list('alice','alice/project'),undefined)
})
test('warmup preloads only the first repo list and never downloads PR details',async()=>{
 const cache=new ReviewCache(()=>0),calls=[]
 const fake={auth:async()=>({account:'alice',source:'github-cli'}),repos:async()=>({items:['alice/project','alice/other'],hasMore:true}),pulls:async(account,repo)=>{calls.push(repo);return {items:[record],hasMore:false}},detail:async()=>{assert.fail('all-PR prefetch is forbidden')}}
 cache.warm(fake);await new Promise(resolve=>setTimeout(resolve,0))
 assert.deepEqual(calls,['alice/project']);assert.equal(cache.list('alice','alice/project').items.length,1);assert.equal(cache.bootstrap('alice').repos.hasMore,true)
})
test('hover prefetch uses the idle queue, is cancelable and head fenced',async()=>{
 const env=idleEnv(),cache=new ReviewCache(()=>0);await cache.activate('alice');let calls=0
 const fake={auth:async()=>({account:'alice',source:'github-cli'}),repos:async()=>({items:[],hasMore:false}),detail:async()=>{calls++;return record}}
 cache.startIdle(fake,env);cache.prefetch(fake,'alice',record);cache.cancelPrefetch();await env.run();assert.equal(calls,0)
 cache.prefetch(fake,'alice',record);await env.run();assert.equal(calls,1);assert.equal(cache.detail('alice',record).id,7)
 cache.dispose()
 const other=new ReviewCache(()=>0),env2=idleEnv();await other.activate('alice')
 const wrong={...fake,detail:async()=>({...record,headSha:'b'.repeat(40)})};other.startIdle(wrong,env2);other.prefetch(wrong,'alice',record);await env2.run();assert.equal(other.detail('alice',record),undefined);other.dispose()

})

test('account transition discards warmed lists/details instead of retaining another identity',()=>{
 const cache=new ReviewCache(()=>0)
 cache.putBootstrap({account:'alice',source:'github-cli'},{items:['alice/project'],hasMore:false});cache.putDetail('alice',record);cache.putList('alice','alice/project',{items:[record],hasMore:false})
 cache.putBootstrap({account:'bob',source:'github-cli'},{items:['bob/project'],hasMore:false})
 assert.equal(cache.detail('alice',record),undefined);assert.equal(cache.list('alice','alice/project'),undefined);assert.equal(cache.bootstrap('bob').identity.account,'bob')
})

function memoryStore(initial){let value=initial;return {read:async()=>value,write:async next=>{value=next},peek:()=>value}}
test('bounded persistent snapshot survives recreation only after account verification, and preserves original TTL',async()=>{
 let clock=1_000;const store=memoryStore(),first=new ReviewCache(()=>clock,store)
 await first.activate('alice');first.putBootstrap({account:'alice',source:'github-cli'},{items:['alice/project'],hasMore:false});first.putList('alice','alice/project',{items:[record],hasMore:false});first.putDetail('alice',record);await first.flush()
 assert.ok(store.peek().length*2<=2*1024*1024);assert.ok(!store.peek().includes('token'));assert.ok(!store.peek().includes('source'))
 clock=61_000;const second=new ReviewCache(()=>clock,store)
 assert.equal(second.detail('alice',record),undefined,'disk is not read before auth')
 await second.activate('alice');assert.equal(second.bootstrap('alice').repos.items[0],'alice/project');assert.equal(second.detail('alice',record).id,7)
 assert.equal(second.detailFresh('alice',record),false);assert.equal(second.listFresh('alice','alice/project'),false)
 second.dispose();first.dispose()
})
test('foreign accounts, corrupt shapes, wrong repositories, versions and oversized snapshots are discarded atomically',async()=>{
 const good=memoryStore(),writer=new ReviewCache(()=>1000,good);await writer.activate('alice');writer.putList('alice','alice/project',{items:[record],hasMore:false});writer.putDetail('alice',record);await writer.flush()
 const snapshot=JSON.parse(good.peek())
 for(const raw of ['{broken',JSON.stringify({...snapshot,account:'bob'}),JSON.stringify({...snapshot,version:2}),JSON.stringify({...snapshot,details:[{value:{...record,body:3},expires:31000}]}),JSON.stringify({...snapshot,lists:[{repository:'other/repo',value:{items:[record],hasMore:false},expires:61000}]}),' '.repeat(2*1024*1024)]){
  const store=memoryStore(raw),cache=new ReviewCache(()=>1000,store);await cache.activate('alice');await cache.flush();assert.equal(cache.detail('alice',record),undefined);assert.equal(cache.list('alice','alice/project'),undefined)
  const written=store.peek();assert.ok(written===undefined||JSON.parse(written).details.length===0)
 }
 writer.dispose()
})
test('switch/reconnect cannot be undone by a late storage restore or pending save',async()=>{
 let finish;const store={read:()=>new Promise(resolve=>{finish=resolve}),write:async()=>{}}
 const cache=new ReviewCache(()=>1000,store),pending=cache.activate('alice');cache.clear();finish(JSON.stringify({version:1,account:'alice',boot:null,lists:[],details:[{value:record,expires:31000}]}));await pending;assert.equal(cache.detail('alice',record),undefined)
 const disk=memoryStore(),switched=new ReviewCache(()=>1000,disk);await switched.activate('alice');switched.putDetail('alice',record);const saving=switched.flush();switched.clear();await saving;await switched.flush();assert.equal(disk.peek(),undefined)
 await switched.activate('bob');assert.equal(switched.detail('alice',record),undefined);switched.dispose()
})
test('storage errors remain nonfatal; persistent bytes and entry counts stay bounded',async()=>{
 const failure={read:async()=>{throw Error('disabled')},write:async()=>{throw Error('quota')}}
 const cache=new ReviewCache(()=>1000,failure);await cache.activate('alice');cache.putDetail('alice',record);await cache.flush();assert.equal(cache.detail('alice',record).id,7)
 const store=memoryStore(),bounded=new ReviewCache(()=>1000,store);await bounded.activate('alice')
 for(let id=1;id<=8;id++){bounded.putDetail('alice',{...record,id,body:'x'.repeat(250_000)});bounded.putList('alice',`alice/repo${id}`,{items:[],hasMore:false})}
 await bounded.flush();assert.ok(store.peek().length*2<=2*1024*1024);const saved=JSON.parse(store.peek());assert.ok(saved.details.length<=3);assert.ok(saved.lists.length<=3)
 cache.dispose();bounded.dispose()
})
test('observed new head invalidates cached diffs immediately; comments/checks still expire independently of SHA',()=>{
 let clock=0;const cache=new ReviewCache(()=>clock);cache.putDetail('alice',record)
 clock=30_000;assert.equal(cache.detailFresh('alice',record,record.headSha),false);assert.equal(cache.detail('alice',record).checks[0].status,'in_progress')
 cache.putList('alice','alice/project',{items:[{...record,headSha:'b'.repeat(40)}],hasMore:false});assert.equal(cache.detail('alice',record),undefined)
})
test('render path reuses fresh cache, refreshes expired cache, preserves last-good records and starts with known summary',()=>{
 const source=readFileSync(new URL('../ui/src/modules/code-review/index.tsx',import.meta.url),'utf8')
 assert.match(source,/await cache.activate\(user.account\)/)
 assert.match(source,/if\(!force&&cache.listFresh/)
 assert.match(source,/if\(cached&&!force&&cache.detailFresh/)
 assert.ok(!source.includes('const page=cached??await'))
 assert.match(source,/setRecord\(old=>cached\?\?/)
 assert.match(source,/selectedSummary\?<section/)
 assert.match(source,/cache.dispose\(\)/)
 assert.match(source,/new BrowserReviewStorage\(indexedDB\)/)
})
test('concurrent opens share one disk restore instead of racing hydration',async()=>{
 let finish,reads=0;const disk={read:()=>{reads++;return new Promise(resolve=>{finish=resolve})},write:async()=>{}}
 const cache=new ReviewCache(()=>1000,disk),one=cache.activate('alice'),two=cache.activate('alice')
 finish(JSON.stringify({version:1,account:'alice',boot:null,lists:[],details:[{value:record,expires:31000}]}));await Promise.all([one,two]);assert.equal(reads,1);assert.equal(cache.detail('alice',record).id,7);cache.dispose()
})
test('browser storage bounds blocked/hung database opens instead of blocking GitHub indefinitely',async()=>{
 const {BrowserReviewStorage}=load('../ui/src/modules/code-review/storage.ts')
 const pending=new BrowserReviewStorage({open:()=>({})}),started=Date.now()
 await assert.rejects(pending.read(),/Review cache unavailable/);assert.ok(Date.now()-started<2500)
 const unavailable=new BrowserReviewStorage({open:()=>{throw Error('disabled')}});await assert.rejects(unavailable.read(),/disabled/)
})

function idleEnv(){
 let clock=0,visible=true,scheduled,changed,input
 const env={now:()=>clock,ready:()=>visible,request:fn=>{scheduled={fn,idle:true};return()=>{scheduled=undefined}},delay:(fn,ms)=>{scheduled={fn,ms};return()=>{scheduled=undefined}},listen:(change,activity)=>{changed=change;input=activity;return()=>{changed=undefined;input=undefined}},async run(budget=20){for(let n=0;n<16&&scheduled;n++){const next=scheduled;scheduled=undefined;if(next.idle){next.fn({timeRemaining:()=>budget});await new Promise(resolve=>setTimeout(resolve,0));if(budget<8)break}else{clock+=next.ms;next.fn()}}},visibility(value){visible=value;changed?.()},activity(){input?.()}}
 return env
}
const {ReviewIdleQueue}=load('../ui/src/modules/code-review/idle.ts')
test('idle queue starts only in quiet visible frames with budget; at most one job runs',async()=>{
 const env=idleEnv(),queue=new ReviewIdleQueue(env),seen=[];let release
 queue.enqueue('one',async()=>{seen.push('one');await new Promise(resolve=>release=resolve)});queue.enqueue('two',async()=>{seen.push('two')})
 env.visibility(false);await env.run();assert.deepEqual(seen,[]);env.visibility(true);await env.run(0);assert.deepEqual(seen,[])
 await env.run();assert.deepEqual(seen,['one']);await env.run();assert.deepEqual(seen,['one']);release();await new Promise(resolve=>setTimeout(resolve,0));await env.run();assert.deepEqual(seen,['one','two']);queue.dispose()
})
test('foreground and input cancel active work; ignored-abort late completion cannot create parallel speculative jobs',async()=>{
 const env=idleEnv(),queue=new ReviewIdleQueue(env);let signal,release,calls=0
 queue.enqueue('one',async s=>{signal=s;calls++;await new Promise(resolve=>release=resolve)});await env.run()
 const finish=queue.foreground();assert.equal(signal.aborted,true);await env.run();assert.equal(calls,1)
 finish(true);await env.run();assert.equal(calls,1,'old transport must settle before another background job')
 queue.remove('one');release();await new Promise(resolve=>setTimeout(resolve,0));queue.enqueue('two',async()=>{calls++});env.activity();await env.run();assert.equal(calls,2);queue.dispose()
})
test('limit errors stop speculative queue without polling; successful explicit foreground work allows future jobs',async()=>{
 const env=idleEnv(),queue=new ReviewIdleQueue(env),seen=[]
 queue.enqueue('one',async()=>{seen.push('one');throw new client.GitHubError('rate_limit','limit')});queue.enqueue('two',async()=>{seen.push('two')});await env.run();assert.deepEqual(seen,['one'])
 queue.enqueue('next',async()=>{seen.push('next')});await env.run();assert.deepEqual(seen,['one'])
 queue.foreground()(true);await env.run();assert.deepEqual(seen,['one','next']);queue.dispose()
})
test('automatic preload is capped at two first-page details, reuses fresh data and never walks pages',async()=>{
 const env=idleEnv(),cache=new ReviewCache(()=>0),seen=[]
 const fake={auth:async()=>({account:'alice',source:'github-cli'}),repos:async()=>({items:['alice/project','alice/other'],hasMore:true}),pulls:async(_account,_repo,index)=>{assert.equal(index,1);return {items:Array.from({length:30},(_,n)=>({...record,id:n+1})),hasMore:true}},detail:async(_account,_repo,id)=>{seen.push(id);return {...record,id}}}
 cache.startIdle(fake,env);await env.run();assert.deepEqual(seen,[1,2]);cache.scheduleDetails('alice',Array.from({length:30},(_,n)=>({...record,id:n+1})));await env.run();assert.deepEqual(seen,[1,2]);cache.dispose()
})
test('GitHubClient foreground release is balanced on success, errors and cancellation',async()=>{
 const seen=[];const api=new client.GitHubClient({call:async()=>{throw Error('offline')}},()=>{seen.push('start');return success=>seen.push(success)})
 await assert.rejects(api.auth(new AbortController().signal));assert.deepEqual(seen,['start',false])
})

test('reset/disposal remove pending jobs and DOM hooks; queue entry count remains bounded',async()=>{
 const env=idleEnv(),queue=new ReviewIdleQueue(env),seen=[]
 for(let n=0;n<20;n++)queue.enqueue(String(n),async()=>{seen.push(n)})
 await env.run();assert.equal(seen.length,6);queue.enqueue('reset',async()=>assert.fail('reset task'));queue.reset();await env.run();queue.enqueue('disposed',async()=>assert.fail('disposed task'));queue.dispose();await env.run();assert.equal(seen.length,6)
})
test('idle preloading is production-registered with a background-only client and foreground hook, not a fixed startup timer',()=>{
 const source=readFileSync(new URL('../ui/src/modules/code-review/index.tsx',import.meta.url),'utf8')
 assert.match(source,/new GitHubClient\(rpc,\(\)=>cache.foreground\(\)\)/);assert.match(source,/cache.startIdle\(backgroundClient,new BrowserIdleEnvironment\(\)\)/)
 assert.ok(!source.includes('setTimeout(()=>cache.warm'));assert.match(source,/cache.scheduleDetails\(account,page.items\)/)
})

test('older speculative head hints cannot evict a newer foreground detail',async()=>{
 const env=idleEnv(),cache=new ReviewCache(()=>1000);await cache.activate('alice');let details=0
 const fake={auth:async()=>({account:'alice',source:'github-cli'}),repos:async()=>({items:[],hasMore:false}),detail:async()=>{details++;return record}}
 cache.putList('alice','alice/project',{items:[record],hasMore:false});cache.putDetail('alice',{...record,headSha:'b'.repeat(40)})
 assert.equal(cache.list('alice','alice/project').items[0].headSha,'b'.repeat(40))
 cache.startIdle(fake,env);cache.scheduleDetails('alice',[record]);cache.prefetch(fake,'alice',record);await env.run()
 assert.equal(details,0);assert.equal(cache.detail('alice',record).headSha,'b'.repeat(40));cache.dispose()
})
