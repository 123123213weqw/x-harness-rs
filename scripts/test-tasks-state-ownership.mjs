/** Real Tasks factory, controlled runtime publications; no HTTP or model calls. */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'
import {ownedViewModuleTestInput} from './owned-view-module-test-input.mjs'
const source=ownedViewModuleTestInput('@xlang/xharness-client-ui-tasks')
const plain=value=>JSON.parse(JSON.stringify(value))
const gate=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
const live=(title='Initial',id='x')=>({sessionId:id,blank:false,running:false,updatedAt:1_780_000_000_000,projections:{values:{title}}})
function fixture(saved={}){
 let registration,snapshot={phase:'ready',loading:false,error:null,sessions:[live()],archivedSessionIds:[],workspaces:[],archivedSessions:[]}
 const listeners=new Set(),calls=[],effects=[],slots=[],cleanups=[],storage=new Map(Object.entries(saved)),handlers={}
 const service={getSnapshot:()=>snapshot,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},refresh:async signal=>{calls.push(['refresh',signal]);if(handlers.refresh)await handlers.refresh(signal)}}
 for(const name of ['rename','archive','unarchive','fork','deleteArchived'])service[name]=async(...args)=>{calls.push([name,...args]);if(handlers[name])await handlers[name](...args)}
 const React={createElement:(type,props,...children)=>({type,props:props??{},children}),useEffect:fn=>effects.push(fn),useRef:()=>({current:null}),useState:initial=>[initial,()=>{}],useSyncExternalStore:(_subscribe,get)=>get()}
 const sandbox={window:{__ModuleLoader__:{load:row=>registration=row},localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)}},document:{documentElement:{lang:'en'},getElementById:()=>null,createElement:()=>({remove(){}}),head:{append(){}}},console,AbortController,Error,Date,Set,Map}
 vm.runInNewContext(source,sandbox)
 const plugin=registration.factory(id=>{if(id==='react')return React;if(id==='@xharness/dsh-client-ui-primitives')return new Proxy({},{get:(_obj,key)=>String(key)});throw Error(id)})
 plugin.apply({get:name=>name==='workCatalog'?service:undefined,effect:fn=>{const cleanup=fn();if(typeof cleanup==='function')cleanups.push(cleanup)},locale:{register(){}},slots:{inject:(_name,fn)=>fn(),register:(spec,component)=>slots.push({spec,component})}})
 return{store:plugin.store,handlers,calls,storage,slots,effects,service,listeners,publish:patch=>{snapshot={...snapshot,...patch};for(const listener of listeners)listener()},mount:()=>{slots[0].component({openSession(){}});return effects.splice(0).map(fn=>fn()).filter(fn=>typeof fn==='function')},dispose:()=>{for(const cleanup of cleanups)cleanup()}}
}
test('Tasks business display fields are read-only; UI pin/menu state is still writable',()=>{
 const f=fixture();for(const name of ['sessions','archivedIds','workspaces']){assert.equal(Object.getOwnPropertyDescriptor(f.store,name).set,undefined);assert.throws(()=>{f.store[name]=[]})}
 assert.throws(()=>f.store.sessions.push(live()));assert.throws(()=>{f.store.sessions[0].projections.values.title='forged'})
 f.store.togglePinned('x');assert.deepEqual(plain(f.store.pinned),['x']);f.store.menuId='x';assert.equal(f.store.menuId,'x');f.dispose()
})
test('Late rename acknowledgement cannot overwrite a newer runtime title',async()=>{
 const f=fixture(),wait=gate();f.handlers.rename=()=>wait.promise;const command=f.store.rename('x','Requested')
 f.publish({sessions:[live('Newer remote title')]});wait.resolve();await command
 assert.equal(f.store.sessions[0].projections.values.title,'Newer remote title');assert.equal(f.store.busyId,null);assert.equal(f.calls.filter(row=>row[0]==='refresh').length,0);f.dispose()
})
test('Late archive acknowledgement cannot recreate a restored membership or unpin it',async()=>{
 const f=fixture(),wait=gate();f.handlers.archive=()=>wait.promise;f.store.togglePinned('x');const command=f.store.archive('x')
 f.publish({sessions:[],archivedSessionIds:['x'],archivedSessions:[{sessionId:'x',title:'Archived',updatedAt:1}]})
 f.publish({sessions:[live('Restored')],archivedSessionIds:[],archivedSessions:[]});f.store.togglePinned('x')
 wait.resolve();await command;assert.deepEqual(plain(f.store.archivedIds),[]);assert.equal(f.store.sessions[0].projections.values.title,'Restored');assert.equal(f.store.snapshots.x,undefined);assert.deepEqual(plain(f.store.pinned),['x']);f.dispose()
})
test('Restore and delete acknowledgements do not erase a later owner archive snapshot',async()=>{
 for(const name of ['restore','deleteArchived']){
  const f=fixture(),wait=gate();f.publish({sessions:[],archivedSessionIds:['x'],archivedSessions:[{sessionId:'x',title:'Original',updatedAt:1}]})
  f.handlers[name==='restore'?'unarchive':'deleteArchived']=()=>wait.promise;f.store.deleteConfirmId='x';const command=f.store[name]('x')
  f.publish({archivedSessionIds:[],archivedSessions:[]});f.publish({archivedSessionIds:['x'],archivedSessions:[{sessionId:'x',title:'New owner record',updatedAt:2}]})
  wait.resolve();await command;assert.deepEqual(plain(f.store.archivedIds),['x']);assert.equal(f.store.snapshots.x.title,'New owner record');f.dispose()
 }
})
test('Missing archive labels on an old Host retain latest observed title, not command-time title',async()=>{
 const f=fixture(),wait=gate();f.handlers.archive=()=>wait.promise;const command=f.store.archive('x')
 f.publish({sessions:[live('Updated while waiting')]});f.publish({sessions:[],archivedSessionIds:['x']});wait.resolve();await command
 assert.equal(f.store.snapshots.x.title,'Updated while waiting');assert.equal(JSON.parse(f.storage.get('xharness.tasks.archive-snapshots.v1')).x.title,'Updated while waiting');f.dispose()
})
test('Host archive labels outrank the staged fallback',async()=>{
 const f=fixture(),wait=gate();f.handlers.archive=()=>wait.promise;const command=f.store.archive('x')
 f.publish({sessions:[],archivedSessionIds:['x'],archivedSessions:[{sessionId:'x',title:'Authoritative',updatedAt:2}]});wait.resolve();await command
 assert.equal(f.store.snapshots.x.title,'Authoritative');f.dispose()
})
test('Failure preserves owner rows and saved archive labels, retry remains possible',async()=>{
 const f=fixture();f.handlers.archive=async()=>{throw Error('denied')};await f.store.archive('x');assert.equal(f.store.sessions.length,1);assert.equal(f.store.snapshots.x,undefined);assert.equal(f.store.actionError,'denied')
 f.publish({sessions:[],archivedSessionIds:['x'],archivedSessions:[{sessionId:'x',title:'Saved',updatedAt:1}]});f.handlers.deleteArchived=async()=>{throw Error('offline')};f.store.deleteConfirmId='x';await f.store.deleteArchived('x')
 assert.equal(f.store.snapshots.x.title,'Saved');assert.equal(f.store.deleteConfirmId,'x');assert.equal(f.store.actionError,'offline')
 f.handlers.deleteArchived=async()=>f.publish({archivedSessionIds:[],archivedSessions:[]});await f.store.deleteArchived('x');assert.equal(f.store.snapshots.x,undefined);f.dispose()
})
test('Page unmount cancels only its wait; late command cannot reopen the menu or restore old data',async()=>{
 const f=fixture(),wait=gate();f.handlers.rename=()=>wait.promise;const cleanups=f.mount();const signal=f.calls.find(row=>row[0]==='refresh')[1]
 f.store.menuId='x';f.store.renameId='x';const command=f.store.rename('x','Stale');for(const cleanup of cleanups)cleanup()
 assert.equal(signal.aborted,true);f.publish({sessions:[live('Changed off-page')]});wait.resolve();await command
 assert.equal(f.store.menuId,null);assert.equal(f.store.renameId,null);assert.equal(f.store.sessions[0].projections.values.title,'Changed off-page')
 f.mount();assert.equal(f.store.sessions[0].projections.values.title,'Changed off-page');f.dispose()
})
test('Plugin disposal fences late command errors and stops pending bulk operations',async()=>{
 for(const name of ['rename','deleteArchivedBatch']){
  const f=fixture(),wait=gate();let invoked=0
  if(name==='rename')f.handlers.rename=()=>wait.promise
  else {f.publish({sessions:[],archivedSessionIds:['a','b']});f.store.deleteConfirmId='all';f.handlers.deleteArchived=()=>{invoked++;return wait.promise}}
  const command=name==='rename'?f.store.rename('x','Late'):f.store.deleteArchivedBatch(['a','b'])
  f.dispose();const version=f.store.version;wait.reject(Error('old scope failed'));await command
  assert.equal(f.store.busyId,null);assert.equal(f.store.actionError,null);assert.equal(f.store.version,version);if(name!=='rename')assert.equal(invoked,1)
 }
})
test('Pending initial baseline preserves old labels and pins, and disposal removes feed observers',()=>{
 const f=fixture({'xharness.tasks.archive-snapshots.v1':JSON.stringify({old:{title:'Legacy',updatedAt:1}}),'xharness.tasks.pinned.v1':JSON.stringify(['x'])})
 f.publish({phase:'pending',sessions:[],archivedSessionIds:[]});assert.equal(f.store.snapshots.old.title,'Legacy');assert.deepEqual(plain(f.store.pinned),['x'])
 const version=f.store.version;f.dispose();assert.equal(f.listeners.size,0);f.publish({sessions:[live('After disposal')]});assert.equal(f.store.version,version)
})
test('Bulk deletion retries parents only after progress, keeps failures, and uses no UI refresh policy',async()=>{
 const f=fixture();f.publish({sessions:[],archivedSessionIds:['parent','child','bad']})
 f.handlers.deleteArchived=async id=>{if(id==='bad'||id==='parent'&&f.store.archivedIds.includes('child'))throw Error('denied');f.publish({archivedSessionIds:f.store.archivedIds.filter(value=>value!==id)})}
 f.store.deleteConfirmId='all';await f.store.deleteArchivedBatch(['parent','child','bad']);assert.deepEqual(f.calls.map(row=>row.slice(0,2)),[['deleteArchived','parent'],['deleteArchived','child'],['deleteArchived','bad'],['deleteArchived','parent'],['deleteArchived','bad'],['deleteArchived','bad']]);assert.deepEqual(plain(f.store.archivedIds),['bad']);assert.match(f.store.actionError,/1.*denied/);assert.equal(f.store.busyId,null);f.dispose()
})
test('Bulk restore skips a row restored externally while an earlier command is pending',async()=>{
 const f=fixture(),wait=gate();f.publish({sessions:[],archivedSessionIds:['a','b']});f.handlers.unarchive=async id=>{if(id==='a')await wait.promise;f.publish({archivedSessionIds:f.store.archivedIds.filter(value=>value!==id)})}
 const command=f.store.restoreArchivedBatch(['a','b']);f.publish({archivedSessionIds:['a']});wait.resolve();await command;assert.deepEqual(f.calls.map(row=>row.slice(0,2)),[['unarchive','a']]);f.dispose()
})
test('Command bodies cannot write business fields or make an extra refresh; immutable projection is adopted in one place',()=>{
 const code=readFileSync(new URL('../ui/src/modules/tasks/index.tsx',import.meta.url),'utf8');const commands=code.slice(code.indexOf('  async rename('),code.indexOf('\nfunction makeT'))
 assert.doesNotMatch(commands,/this\.(?:sessions|archivedIds|workspaces)\s*=/);assert.doesNotMatch(commands,/\.values\.title\s*=/);assert.doesNotMatch(commands,/await this\.refresh\(/);assert.doesNotMatch(commands,/delete this\.snapshots/)
 assert.match(code,/readonly sessions: readonly TaskSession\[\]/);assert.match(code,/get archivedIds\(\)/)
})
