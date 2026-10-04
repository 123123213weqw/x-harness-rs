import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
const require=createRequire(new URL('../ui/package.json',import.meta.url))
const compiled=require('esbuild').buildSync({entryPoints:[new URL('../ui/src/modules/client-runtime/work/catalog.ts',import.meta.url).pathname],bundle:true,write:false,format:'cjs',platform:'node'}).outputFiles[0].text
const module={exports:{}}
vm.runInNewContext(compiled,{module,exports:module.exports,queueMicrotask,DOMException,Promise,Map,Set,Error})
const {WorkCatalog}=module.exports
const tick=async()=>{for(let i=0;i<8;i++)await Promise.resolve()}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
function fixture(){
 const listeners=[new Set(),new Set()],calls=[]
 let ss={ids:['a'],byId:{a:{id:'a',title:'Alpha',running:false,blank:false,updatedAt:1,projectionValues:{schedules:[]}}},phase:'ready'}
 let ws={items:[],archivedSessionIds:[],phase:'ready',state:'idle',error:null},status={state:'idle',error:null},archives=[]
 const read=(i,get)=>({subscribe:fn=>{listeners[i].add(fn);return()=>listeners[i].delete(fn)},getSnapshot:get})
 const sessions={list:read(0,()=>ss),catalogStatus:()=>status,refresh:async()=>{calls.push('sessions.refresh')},fork:async input=>{calls.push(['fork',input]);return'child'}}
 const workspaces={list:read(1,()=>ws),archivedSummaries:()=>archives,refresh:async()=>{calls.push('workspaces.refresh')},archiveSession:async id=>{calls.push(['archive',id])}}
 const command=async(method,payload)=>{calls.push([method,payload]);return{result:{ok:true,value:{deleted:true}}}}
 const api={sessions:{rename:p=>command('rename',p),delete:p=>command('delete',p)},workspace:{unarchiveSession:p=>command('unarchive',p)}}
 const catalog=new WorkCatalog(api,sessions,workspaces)
 return{catalog,api,sessions,workspaces,calls,listeners,changeSessions:next=>{ss=next;for(const fn of listeners[0])fn()},changeWorkspaces:next=>{ws=next;for(const fn of listeners[1])fn()},setStatus:next=>{status=next;for(const fn of listeners[0])fn()},setArchives:rows=>{archives=rows;for(const fn of listeners[1])fn()}}
}
test('Work feed is metadata-only, reference stable and live across pages',async()=>{
 const f=fixture();const snapshot=f.catalog.getSnapshot();assert.equal(snapshot,f.catalog.getSnapshot());assert.equal(snapshot.phase,'ready');assert.equal(snapshot.sessions[0].sessionId,'a')
 let updates=0;const off=f.catalog.subscribe(()=>updates++)
 f.changeSessions({ids:['a'],byId:{a:{title:'Changed',running:true,blank:false,updatedAt:2,projectionValues:{schedules:[{id:'s'}]},messageBody:'do not read'}},phase:'ready'})
 await tick();const next=f.catalog.getSnapshot();assert.equal(next.sessions[0].projections.values.title,'Changed');assert.equal(next.sessions[0].running,true);assert.equal(next.sessions[0].projections.values.schedules.length,1);assert.equal(next.sessions[0].messageBody,undefined);assert.ok(updates>0);assert.deepEqual(f.calls,[]);off();f.catalog.dispose()
})
test('Unknown baseline cannot become an authoritative empty catalog',async()=>{const f=fixture();f.changeSessions({ids:[],byId:{},phase:'pending'});await tick();assert.equal(f.catalog.getSnapshot().phase,'pending');f.changeSessions({ids:[],byId:{},phase:'ready'});await tick();assert.equal(f.catalog.getSnapshot().phase,'ready');assert.equal(f.catalog.getSnapshot().sessions.length,0)})
test('Concurrent refreshes reuse both owner pulls; abort isolates the reader',async()=>{
 const f=fixture(),gate=deferred();let reads=0
 f.sessions.refresh=()=>{reads++;return gate.promise}
 const a=new AbortController(),b=new AbortController();const first=f.catalog.refresh(a.signal),second=f.catalog.refresh(b.signal)
 const rejected=assert.rejects(first,/Reader cancelled/);a.abort();await rejected;assert.equal(reads,1);assert.equal(f.calls.filter(x=>x==='workspaces.refresh').length,1)
 gate.resolve();await second;await tick();assert.equal(f.catalog.getSnapshot().loading,false)
 const cancelled=new AbortController();cancelled.abort();await assert.rejects(f.catalog.refresh(cancelled.signal),/Reader cancelled/);assert.equal(reads,1)
})
test('Failure remains visible with old records; retry adopts repaired owner',async()=>{
 const f=fixture();f.setStatus({state:'error',error:{code:'internal',message:'offline'}});await assert.rejects(f.catalog.refresh(),/offline/);await tick();assert.equal(f.catalog.getSnapshot().error,'offline');assert.equal(f.catalog.getSnapshot().sessions.length,1)
 f.setStatus({state:'idle',error:null});await f.catalog.refresh();await tick();assert.equal(f.catalog.getSnapshot().error,null)
})
test('All typed mutations route to the existing owners/client, no private RPC IDs',async()=>{
 const f=fixture();await f.catalog.rename('a','New');await f.catalog.archive('a');await f.catalog.unarchive('a');await f.catalog.fork('a');await f.catalog.deleteArchived('a')
 const commands=f.calls.filter(Array.isArray);assert.deepEqual(commands.map(x=>x[0]),['rename','archive','unarchive','fork','delete']);assert.equal(commands[0][1].sessionId,'a');assert.equal(commands[0][1].title,'New');assert.equal(commands[2][1].sessionId,'a')
 assert.equal(f.calls.filter(row=>row==='sessions.refresh').length,5,'each mutation owns its session baseline read, including fork')
 assert.equal(f.calls.filter(row=>row==='workspaces.refresh').length,3,'unarchive/fork/delete own their workspace reads; pages add none')
 await assert.rejects(f.catalog.archive(''),/empty/)
})
test('Denied mutation does not perform a success refresh',async()=>{const f=fixture();f.api.sessions.delete=async()=>({result:{ok:false,error:{code:'internal',message:'deny'}}});await assert.rejects(f.catalog.deleteArchived('a'),/deny/);assert.equal(f.calls.length,0)})
test('Disposal removes subscriptions and prevents late baseline publication/actions',async()=>{
 const f=fixture(),gate=deferred();f.sessions.refresh=()=>gate.promise;let notifications=0;f.catalog.subscribe(()=>notifications++);const request=f.catalog.refresh();await tick();const before=notifications;f.catalog.dispose();assert.equal(f.listeners[0].size,0);assert.equal(f.listeners[1].size,0);gate.resolve();await assert.rejects(request,/disposed/);await tick();assert.equal(notifications,before);await assert.rejects(f.catalog.rename('a','B'),/disposed/)
})
test('Old workspace metadata absence stays compatible; archive membership stays authoritative',async()=>{const f=fixture();f.changeWorkspaces({items:[{workspaceId:'w'}],archivedSessionIds:['a'],phase:'ready',state:'idle',error:null});f.setArchives([]);await tick();assert.equal(f.catalog.getSnapshot().archivedSessions.length,0);assert.equal(f.catalog.getSnapshot().archivedSessionIds[0],'a')})
test('Feature pages have no private transport; runtime owns and disposes one Work feed',()=>{
 for(const p of ['tasks/index.tsx','schedule/automation-data.ts','schedule/AutomationNavigation.tsx']){const s=readFileSync(new URL('../ui/src/modules/'+p,import.meta.url),'utf8');assert.ok(!s.includes('fetch('));assert.ok(!s.includes('/api/'));assert.ok(!s.includes('client-request'))}
 const s=readFileSync(new URL('../ui/src/modules/client-runtime/index.ts',import.meta.url),'utf8');assert.match(s,/new WorkCatalog\(connection.api, sessions, workspaces\)/);assert.match(s,/workCatalog.dispose\(\)/)
})

const managerCode=require('esbuild').buildSync({entryPoints:[new URL('../ui/src/modules/client-runtime/workspaces/manager.ts',import.meta.url).pathname],bundle:true,write:false,format:'cjs',platform:'node'}).outputFiles[0].text
const managerModule={exports:{}}
vm.runInNewContext(managerCode,{module:managerModule,exports:managerModule.exports,queueMicrotask,Promise,Map,Set,Error,console})
const {WorkspaceManager}=managerModule.exports
const result=value=>({result:{ok:true,value}})
const plain=value=>JSON.parse(JSON.stringify(value))
test('Actual workspace owner retains metadata but never revives an in-flight archived baseline',async()=>{
 let pull=async()=>result({items:[],archivedSessionIds:['a'],archivedSessions:[{sessionId:'a',title:'Saved Alpha',updatedAt:1}]})
 const manager=new WorkspaceManager({workspace:{list:()=>pull()}})
 await manager.refresh();assert.equal(manager.archivedSummaries()[0].title,'Saved Alpha')
 const gate=deferred();pull=()=>gate.promise;const request=manager.refresh()
 manager.handleHostEnvelope({rpcId:'restored',payload:{type:'host/archived-sessions-changed',archivedSessionIds:[]}})
 gate.resolve(result({items:[],archivedSessionIds:['a'],archivedSessions:[{sessionId:'a',title:'Stale Alpha',updatedAt:0}]}));await request
 assert.deepEqual(plain(manager.getSnapshot().archivedSessionIds),[]);assert.deepEqual(plain(manager.archivedSummaries()),[])
 // Existing archive frames do not carry labels. A later successful pull hydrates them.
 pull=async()=>result({items:[],archivedSessionIds:['b'],archivedSessions:[{sessionId:'b',title:'Beta',updatedAt:2}]})
 manager.handleConnected();await manager.refresh();assert.deepEqual(plain(manager.archivedSummaries()),[{sessionId:'b',title:'Beta',updatedAt:2}])
 // Older Hosts omit the optional summaries; membership still remains valid.
 pull=async()=>result({items:[],archivedSessionIds:['b']});await manager.refresh()
 assert.deepEqual(plain(manager.getSnapshot().archivedSessionIds),['b']);assert.deepEqual(plain(manager.archivedSummaries()),[])
})
test('Actual workspace owner preserves last-good labels on failed pull and adopts same-id label repairs',async()=>{
 let fail=false,title='Alpha';const manager=new WorkspaceManager({workspace:{list:async()=>fail?{result:{ok:false,error:{code:'internal',message:'offline',details:{}}}}:result({items:[],archivedSessionIds:['a'],archivedSessions:[{sessionId:'a',title,updatedAt:1}]})}})
 await manager.refresh();fail=true;await manager.refresh();assert.equal(manager.getSnapshot().error.message,'offline');assert.equal(manager.archivedSummaries()[0].title,'Alpha')
 fail=false;title='Corrected';let notified=0;manager.subscribe(()=>notified++);await manager.refresh();await tick();assert.equal(manager.archivedSummaries()[0].title,'Corrected');assert.ok(notified>0)
})
