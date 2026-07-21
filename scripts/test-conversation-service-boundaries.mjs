/** Latest frozen/source service factories on the actual pinned Core kernel. */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import {compileSourceModules} from './build-source-modules.mjs'
import {loadOwnedCordisRuntime,loadOwnedSnapshotRuntime} from './fixtures/owned-view-cordis-runtime.mjs'
const Core=loadOwnedCordisRuntime(),runtime=loadOwnedSnapshotRuntime()
const entries=[['commands','@xharness/dsh-client-ui-commands'],['input-trigger','@xharness/dsh-client-ui-input-trigger'],['reference','@xharness/dsh-client-ui-reference'],['typert-registry','@xharness/dsh-typert-registry']]
const compiled=compileSourceModules(new URL('../ui',import.meta.url).pathname,entries.map(([name,id])=>({id,source:`src/modules/${name}/index.ts`})))
function load(implementation,name){
 const id=entries.find(row=>row[0]===name)[1],source=implementation==='source'?compiled.get(id).bytes.toString():readFileSync(`ui/reference/master-a613970/plugins/${id}/client.js`,'utf8');let registration
 const jsx=(type,props,key)=>({type,props,key}),react={useState:initial=>[typeof initial==='function'?initial():initial,()=>{}],useRef:value=>({current:value}),useEffect(){},useLayoutEffect(){},useMemo:fn=>fn(),useCallback:fn=>fn,memo:fn=>fn}
 vm.runInNewContext(source,{window:{__ModuleLoader__:{load:row=>registration=row}},document:{querySelector:()=>null,getElementById:()=>null,createElement:()=>({dataset:{}}),head:{appendChild(){}}},console,AbortController,AbortSignal,Date,queueMicrotask,setTimeout,clearTimeout,setInterval,clearInterval})
 return registration.factory(name=>name==='@xharness/cordis'?Core:name==='@xharness/dsh-client-runtime/client'?runtime:name==='react'?react:name==='react/jsx-runtime'?{jsx,jsxs:jsx,Fragment:'fragment'}:name==='@xharness/dsh-client-ui-primitives'?new Proxy({},{get:(_o,k)=>String(k)}):name==='@xharness/dsh-client-ui-slots'?{resolveSlotLabel:value=>value}:(()=>{throw Error(name)})())
}
const normalize=value=>JSON.parse(JSON.stringify(value))
const tick=()=>new Promise(resolve=>setImmediate(resolve))
function domain(root,plainRemote=true){
 const scopes=new Map(),trace=[],sources=[]
 const sessions={scope:id=>scopes.get(id),scopeOf:ctx=>ctx.sessionId,subagentAddress:()=>undefined}
 const remote={commands:{list:async()=>({ok:true,value:[{name:'clear',description:'Clear'},{name:'goal',description:'Goal',input:{hint:'objective'}}]}),execute:async(id,line,images)=>{trace.push(['execute',id,line,images]);return{ok:true,value:{result:{kind:'success'}}}}},$on:()=>()=>{},fileReferences:{list:async()=>({ok:true,value:[{kind:'file',path:'space name.ts'},{kind:'directory',path:'src'}]})},sessionReferenceResolver:{candidates:async()=>({ok:true,value:[{sessionId:'other',label:'Other',mention:'@session:other',createdAt:0}]})}}
 root.provide('sessions',sessions);root.provide('locale',{bind:()=>key=>key,register:()=>()=>{}});if(plainRemote){root.provide('remote',remote);root.provide('remote.commands',remote.commands)}
 return{scopes,sessions,trace,sources,remote}
}
for(const implementation of ['legacy','source']){
 test(`${implementation}: decoration registration does not acquire a caller's undeclared commands namespace`,async()=>{
  const root=new Core.Context(),d=domain(root,false),input=load(implementation,'input-trigger'),command=load(implementation,'commands')
  class Remote extends Core.Service{constructor(ctx){super(ctx,'remote')}$on(){return()=>{}}}
  const remoteOwner=root.plugin({name:'remote-owner-sibling',apply(ctx){new Remote(ctx);ctx.provide('remote.commands',d.remote.commands)}});await remoteOwner
  await root.plugin(input.InputTriggerService);await root.plugin(command.CommandUiRuntime)
  let caller;const child=root.plugin({name:'permission-decoration-caller',inject:['commandUi','remote'],apply(ctx){caller=ctx
   assert.throws(()=>ctx.remote.commands,/cannot get property "remote\.commands" without inject/,'genuine tracked namespace policy is active')
   ctx.commandUi.decorate({name:'clear',available:()=>true,ui:{kind:'popupSelect',options:async()=>[{id:'safe',label:'Safe'}],onSelect:async()=>{}}})
   ctx.commandUi.register({name:'local',description:'Caller local',available:()=>true,ui:{kind:'popupSelect',options:async()=>[],onSelect:async()=>{}}})
  }});await child
  assert.ok(Core.Context.is(caller));assert.equal(caller.commandUi.live.decorations.has('clear'),true,'decoration only registers an effect, not a Remote dependency')
  assert.equal(caller.commandUi.live.contributions.has('local'),true)
  await child.dispose();assert.equal(root.commandUi.live.decorations.has('clear'),false);assert.equal(root.commandUi.live.contributions.has('local'),false,'actual caller disposal still owns registration')
  await root.fiber.dispose()
 })
 test(`${implementation}: command registration follows actual caller fibers, popup scopes and listener rejection containment`,async()=>{
  const root=new Core.Context(),d=domain(root),warn=[];root.logger.warn=(...args)=>warn.push(args)
  const input=load(implementation,'input-trigger'),command=load(implementation,'commands');await root.plugin(input.InputTriggerService);await root.plugin(command.CommandUiRuntime)
  let oneCtx,twoCtx,onePopup,twoPopup
  const one=root.plugin({name:'commands-caller-one',inject:['commandUi','inputTriggers'],apply(ctx){oneCtx=ctx.extend({sessionId:'one'});d.scopes.set('one',oneCtx);onePopup=oneCtx.commandUi.popupFor(oneCtx);oneCtx.commandUi.register({name:'one',description:'One',available:()=>true,ui:{kind:'popupSelect',options:async()=>[],onSelect:async()=>{}}})}})
  const two=root.plugin({name:'commands-caller-two',inject:['commandUi','inputTriggers'],apply(ctx){twoCtx=ctx.extend({sessionId:'two'});d.scopes.set('two',twoCtx);twoPopup=twoCtx.commandUi.popupFor(twoCtx);twoCtx.commandUi.register({name:'two',description:'Two',available:()=>true,ui:{kind:'popupSelect',options:async()=>[],onSelect:async()=>{}}})}})
  await one;await two;assert.notEqual(onePopup,twoPopup);assert.equal(oneCtx.commandUi.popupFor(oneCtx),onePopup)
  const signal=new AbortController().signal,controller=root.inputTriggers.sessionOf(oneCtx)
  controller.track('/',1,{tier:'plain'},1);await tick();assert.deepEqual(normalize(controller.menu.getSnapshot().groups.flatMap(row=>row.items.map(item=>item.name))),['clear','goal','one','two'])
  const off1=root.on('command/executed',()=>{throw Error('sync observer')}),off2=root.on('command/executed',()=>Promise.reject(Error('async observer')))
  const outcome=await controller.adjudicate('/clear',signal,{images:0});assert.equal(outcome,'handled');await tick();assert.equal(d.trace[0][2],'/clear');assert.equal(warn.length,4,'both observer failures are contained and reported')
  off1();off2();await one.dispose();controller.track('/',1,{tier:'plain'},2);await tick();assert.equal(controller.menu.getSnapshot().open,false,'disposed scope owns its trigger controller')
  const surviving=root.inputTriggers.sessionOf(twoCtx);surviving.track('/',1,{tier:'plain'},3);await tick();assert.deepEqual(normalize(surviving.menu.getSnapshot().groups.flatMap(row=>row.items.map(item=>item.name))),['clear','goal','two'],'one caller does not retire two caller contribution')
  await two.dispose();await root.fiber.dispose()
 })
 test(`${implementation}: input service reads current isolated sessions and retains independent controller lifetime`,async()=>{
  const root=new Core.Context(),d=domain(root),api=load(implementation,'input-trigger');await root.plugin(api.InputTriggerService)
  const warmed=[],remove=root.inputTriggers.registerSource({trigger:'@',name:'warm',warm:session=>warmed.push(session.sessionId),lexicon:()=>['live'],candidates:async()=>[{name:'candidate'}]})
  const isolated=root.isolate('sessions');isolated.provide('sessions',{scope:id=>d.scopes.get(id),scopeOf:ctx=>ctx.sessionId?'isolated:'+ctx.sessionId:undefined})
  let actx,ordinary,separate;const child=isolated.plugin({name:'trigger-caller',inject:['inputTriggers','sessions'],apply(ctx){actx=ctx.extend({sessionId:'same'});ordinary=root.inputTriggers.sessionOf(actx);separate=ctx.inputTriggers.sessionOf(actx)}})
  await child;assert.notEqual(ordinary,separate,'tracker reads caller isolated sessions rather than fixed ownerCtx');assert.deepEqual(warmed,['same','isolated:same']);assert.equal(actx.inputTriggers.sessionOf(actx),separate)
  separate.track('@c',2,{tier:'plain'},1);await tick();assert.equal(separate.menu.getSnapshot().open,true);await child.dispose();assert.equal(separate.menu.getSnapshot().open,false);assert.equal(ordinary.menu.getSnapshot().open,false)
  remove();remove();await root.fiber.dispose()
 })
 test(`${implementation}: reference callback wire values, quoted order, cancellation and registration teardown preserve original behavior`,async()=>{
  const root=new Core.Context(),d=domain(root),input=load(implementation,'input-trigger');await root.plugin(input.InputTriggerService)
  const signal=new AbortController().signal;let controller,source
  const original=root.inputTriggers.registerSource.bind(root.inputTriggers);root.inputTriggers.registerSource=entry=>{source=entry;return original(entry)}
  const child=root.plugin({name:'reference-caller',inject:['inputTriggers','locale','remote'],apply(ctx){load(implementation,'reference').apply(ctx);controller=ctx.inputTriggers.sessionOf(ctx.extend({sessionId:'ref'}))}});await child
  const rows=await source.candidates({sessionId:'ref'},{query:'',signal});assert.equal(rows.length,3);assert.equal(JSON.parse(rows[0].value).kind,'file');assert.equal(JSON.parse(rows[2].value).kind,'session');assert.deepEqual(normalize(source.onPick({candidate:rows[1]})),{text:'@src/',continue:true});assert.equal(source.onPick({candidate:rows[0]}).insert.clipboardText,'@"space name.ts"')
  const quoted=await source.candidates({sessionId:'ref'},{query:'',quoted:true,signal});assert.equal(quoted.length,2);const aborted=new AbortController();aborted.abort();assert.deepEqual(normalize(await source.candidates({sessionId:'ref'},{query:'',signal:aborted.signal})),[])
  assert.equal(await source.codec.serialize('@"space name.ts"'), '@"space name.ts"');await child.dispose();controller.track('@',1,{tier:'plain'},1);await tick();assert.equal(controller.menu.getSnapshot().open,false);await root.fiber.dispose()
 })
 test(`${implementation}: Typert heterogeneous lookup/Context policies remain erased unknown and caller-owned`,async()=>{
  const root=new Core.Context();load(implementation,'typert-registry').apply(root)
  const host=root.extend({identity:'default'}),override=root.extend({identity:'override'}),value={foreign:{keep:true}};let oneCtx,twoCtx
  const one=root.plugin({name:'registry-caller-one',inject:['typert'],apply(ctx){oneCtx=ctx;ctx.typert.lookups.register('item',{parameter:'item',wire:'itemId',hostTypeSymbol:'Item',wireTypeSymbol:'string',resolve:()=>value});ctx.typert.contexts.registerHost('session',{wire:'sessionId',wireTypeSymbol:'string',resolve:()=>host})}})
  const two=root.plugin({name:'registry-caller-two',inject:['typert'],apply(ctx){twoCtx=ctx;ctx.typert.lookups.configure('item',()=>Promise.resolve(value));ctx.typert.contexts.configureHost('session',()=>override);ctx.typert.contexts.registerClient('session',{identity:ctx=>ctx.sessionId})}})
  await one;await two;assert.equal(await root.typert.lookups.get('item').resolve('s'),value);assert.equal(await root.typert.contexts.getHost('session').resolve('s'),override);assert.equal(root.typert.contexts.getClient('session').identity(root.extend({sessionId:'s'})),'s')
  await two.dispose();assert.equal(await oneCtx.typert.lookups.get('item').resolve('s'),value);assert.equal(await oneCtx.typert.contexts.getHost('session').resolve('s'),host);assert.equal(root.typert.contexts.getClient('session'),undefined)
  await one.dispose();assert.equal(root.typert.lookups.get('item'),undefined);assert.equal(root.typert.contexts.getHost('session'),undefined);assert.equal(root.typert.lookups.definitions()[0].wire,'itemId');assert.ok(Core.Context.is(twoCtx));await root.fiber.dispose()
 })
}
