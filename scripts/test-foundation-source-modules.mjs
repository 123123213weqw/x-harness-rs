import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { compileSourceModules } from './build-source-modules.mjs'
import { loadOwnedCordisRuntime } from './fixtures/owned-view-cordis-runtime.mjs'
const Core = loadOwnedCordisRuntime()

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(join(repo, 'ui/package.json'))
const ts = require('typescript')
// Compile with exactly the release compiler: original SDK paths, strict
// declarations, module-closure policy, and pinned runtime vendors. No custom
// lower-strictness test program and no implementation-only transpilation.
const compiledEntries = new Map()
const schemaRealms = new WeakMap()
function rememberSchemaRealm(exports,realm){
  for(const value of Object.values(exports))if(value&&typeof value==='object'&&typeof value.safeParse==='function')schemaRealms.set(value,realm)
  return exports
}
function schemaRealmInput(schema,value){
  if(value===undefined)return undefined
  const realm=schemaRealms.get(schema)
  assert.ok(realm,'each actual schema owns its execution realm')
  // A JSON wire value is decoded by the schema's own JS realm, exactly like
  // the browser JSON carrier. Do not normalize/erase any Zod issue strings.
  return vm.runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(value))})`,realm)
}
function compiledEntry(name, entry = 'index') {
  const key = `${name}/${entry}`
  let bytes = compiledEntries.get(key)
  if (bytes === undefined) {
    const id = `foundation-acceptance:${key}`
    bytes = compileSourceModules(join(repo, 'ui'), [{ id, source: `src/modules/${key}.ts` }]).get(id).bytes.toString()
    compiledEntries.set(key, bytes)
  }
  return bytes
}

function legacy(name, globals = {}, externals = {}) {
  let registration
  const context = { window: { __ModuleLoader__: { load(value) { registration = value } } }, console, Promise, AbortController, AbortSignal, URL, Error, navigator: {languages: ['en'], language: 'en'}, ...globals }
  context.window = {...globals.window, __ModuleLoader__: {load(value) {registration=value}}}
  vm.runInNewContext(readFileSync(join(repo, `ui/reference/master-a613970/plugins/@xharness/dsh-${name}/client.js`), 'utf8'), context)
  return registration.factory(spec => { if (spec in externals) return externals[spec]; throw new Error(`Unexpected external import ${spec}`) })
}
function sourceModule(name, globals = {}, externals = {}, entry = 'index') {
  let registration
  const context = {console, Promise, AbortController, AbortSignal, URL, Error,
    navigator: {languages:['en'],language:'en'}, queueMicrotask,
    process:{env:{NODE_ENV:'production'}}, EventSource:globalThis.EventSource,
    document:globalThis.document, ...globals,
    window:{...globals.window,__ModuleLoader__:{load(value){registration=value}}}}
  const realm=vm.createContext(context)
  vm.runInContext(compiledEntry(name,entry),realm)
  const exports=registration.factory(spec => {
    if (spec in externals) return externals[spec]
    throw new Error(`Unexpected source external import ${spec}`)
  })
  return rememberSchemaRealm(exports,realm)
}

const jsx = { jsx: (type, props) => ({type, props}), jsxs: (type, props) => ({type, props}), Fragment: 'fragment' }
const zod = require('zod')
const primitives = {Modal: 'Modal', Button: 'Button', IconDownloadOutline16: 'download', IconChevronDownOutline14: 'chevron', Menu: 'Menu'}
function snapshot(initial) {
  let state = structuredClone(initial); const listeners = new Set()
  return {getSnapshot: () => state, subscribe: fn => {listeners.add(fn); return () => listeners.delete(fn)}, update: edit => {state = {...state}; edit(state); for (const fn of listeners) fn()}}
}
const runtime = {createSnapshotStore: snapshot, defineStore: definition => definition}
const viewExternals = {'@xharness/dsh-client-runtime/client': runtime, 'react/jsx-runtime': jsx, 'react': {useState: initial => [initial, () => {}]}, '@xharness/dsh-client-ui-primitives': primitives}
const current = sourceModule('client-modules')
const old = legacy('client-modules')
const row = (id, external = []) => ({ id, url: `/${id}.js`, rev: id, external })
function create(api, rows = [], options = {}) {
  const target = { mode: 'queue', pendingQueue: options.pending ?? [], load(registration) { this.pendingQueue.push(registration) }, create() { throw new Error('not used') } }
  const graph = { rev: 'test', entries: rows }
  const system = api.createClientModuleSystem(target, { id: 'modules', exports: api }, { boot: graph, staticModules: options.seed ?? {}, ...(options.loadBundle ? { loadBundle: options.loadBundle } : {}) })
  return { system, target }
}
for (const [label, api] of [['legacy', old], ['source', current]]) {
  test(`${label}: parser validates malformed boot boundaries and copies arrays`, () => {
    for (const wire of [null, [], {}, {rev: 1, entries: []}, {rev: '', entries: [null]}, {rev: '', entries: [row('x', [1])]}, {rev: '', entries: [{...row('x'), immediately: 'yes'}]}]) {
      assert.throws(() => api.parseBootManifest(wire), /client-modules:/)
    }
    const entries = [{...row('x', ['dep/client']), inject: ['slot'], immediately: true}]
    const manifest = api.parseBootManifest({rev: 'r', entries})
    entries[0].external.push('late')
    assert.deepEqual(Array.from(manifest.modules[0].external), ['dep/client'])
    assert.deepEqual(Array.from(manifest.plugins[0].inject), ['slot'])
    assert.equal(manifest.plugins[0].immediately, true)
  })
  test(`${label}: queue switch, lazy registration, memoization, seed and /client aliases`, async () => {
    let runs = 0
    const exports = {answer: 42}
    const {system, target} = create(api, [row('a')], {seed: {react: exports}, pending: [{id: 'a/client', factory: require => { runs++; return {react: require('react')} }}]})
    assert.equal(target.mode, 'live'); assert.equal(target.pendingQueue.length, 0); assert.equal(runs, 0)
    const a = await system.import('a/client')
    assert.equal(a.react, exports); assert.equal(await system.import('a'), a); assert.equal(runs, 1)
    assert.equal(await system.import('react'), exports)
    assert.deepEqual(Array.from(system.loadCache.get('a').edges), ['react'])
    system.invalidate('modules'); assert.equal(await system.import('modules'), api)
    assert.throws(() => target.load({id: 'a', factory: () => ({})}), /duplicate factory/)
  })
  test(`${label}: external arrivals are ordered, inject is informational, in-flight loads coalesce`, async () => {
    const loaded = []; let target
    const loadBundle = async url => { loaded.push(url); await new Promise(resolve => setTimeout(resolve, 2)); const id = url.slice(1, -3); target.load({id, factory: require => id === 'consumer' ? {dependency: require('dep/client')} : {id}}) }
    const created = create(api, [row('dep'), {...row('consumer', ['dep/client']), inject: ['nonexistent']}], {loadBundle})
    target = created.target
    await Promise.all([created.system.prefetch('consumer'), created.system.prefetch('consumer/client')])
    assert.deepEqual(loaded, ['/dep.js', '/consumer.js']); assert.equal(created.system.loadCache.has('consumer'), false)
    assert.equal((await created.system.import('consumer')).dependency.id, 'dep')
  })
  test(`${label}: missing registration, retries, graph cycles and require cycles fail loudly`, async () => {
    let count = 0; let target
    const loadBundle = async () => { if (++count > 1) target.load({id: 'a', factory: () => ({retry: true})}) }
    const c = create(api, [row('a')], {loadBundle}); target = c.target
    await assert.rejects(c.system.prefetch('a'), /loaded without registering/)
    await c.system.prefetch('a'); assert.equal((await c.system.import('a')).retry, true)
    await assert.rejects(create(api, [row('a', ['b']), row('b', ['a'])]).system.prefetch('a'), /arrival cycle a -> b -> a/)
    const cycle = create(api, [], {pending: [{id: 'a', factory: r => ({b: r('b')})}, {id: 'b', factory: r => ({a: r('a')})}]})
    await assert.rejects(cycle.system.import('a'), /require cycle/)
    await assert.rejects(cycle.system.import('missing'), /cannot resolve/)
    await assert.rejects(cycle.system.prefetch('missing'), /not a graph entry/)
    assert.throws(() => create(api, [row('a'), row('a')]), /duplicate graph entry/)
  })
  test(`${label}: invalidation reloads and failed factories do not cache partial records`, async () => {
    let runs = 0
    const {system, target} = create(api, [row('a')], {pending: [{id:'a', factory: () => { if (++runs === 1) throw new Error('body failed'); return {runs} }}]})
    await assert.rejects(system.import('a'), /body failed/); assert.equal(system.loadCache.has('a'), false)
    assert.equal((await system.import('a')).runs, 2)
    system.invalidate('a'); target.load({id: 'a', factory: () => ({new: true})})
    assert.equal((await system.import('a/client')).new, true)
  })
}

test('source: strict HMR SSE boundary and serialized lifecycle preserve old behavior', async () => {
  const trace = []; let receive; let closed = false; let dispose
  const oldDocument = globalThis.document; const oldEventSource = globalThis.EventSource
  globalThis.document = {querySelectorAll: () => [{getAttribute: () => 'a', remove: () => trace.push('style')}]}
  globalThis.EventSource = class { constructor(url) { trace.push(url) } addEventListener(_event, listener) { receive = listener } close() { closed = true } }
  try {
    const hmr = sourceModule('client-hmr')
    const entry = {options: {name: 'a'}, ctx: {registry: {delete: () => trace.push('registry')}}, fiber: {runtime: {callback: 'runtime'}, inertia: undefined, await: async () => trace.push('new.await')}, refresh: async () => { trace.push('refresh'); entry.fiber = {runtime: null, await: async () => trace.push('new.await')} }}
    hmr.apply({modules: {invalidate: id => trace.push(`invalidate:${id}`), prefetch: async id => { trace.push(`prefetch:${id}`); await new Promise(r => setTimeout(r,2)) }}, loader: {entries: () => [entry]}, logger: {warn: message => trace.push(message), error: message => trace.push(String(message))}, effect: effect => {dispose = effect()} })
    receive({data: JSON.stringify({type: 'rebuilt', id: 'a', rev: 'r'})}); receive({data: JSON.stringify({type: 'rebuilt', id: 'a', rev: 's'})})
    await new Promise(r => setTimeout(r, 30))
    assert.deepEqual(trace.slice(1), ['invalidate:a', 'prefetch:a', 'registry', 'style', 'refresh', 'new.await', 'invalidate:a', 'prefetch:a', 'style', 'refresh', 'new.await'])
    receive({data: 'not-json'}); receive({data: JSON.stringify(null)}); receive({data: JSON.stringify({type:'rebuilt',id:3})})
    assert.match(trace.at(-3), /unparseable/); assert.match(trace.at(-2), /invalid/); assert.match(trace.at(-1), /invalid/)
    dispose(); assert.equal(closed, true)
  } finally {globalThis.document = oldDocument; globalThis.EventSource = oldEventSource}
})

function gatewayContext() {
  const root=new Core.Context(), trace=[];let request=async(_route,_endpoint,params)=>({ok:true,value:params.args.value})
  const ctx=root.extend({identity:'sid'})
  root.provide('typert',{remotes:{register:contribution=>{trace.push(`mount:${contribution.package}`);return()=>trace.push(`dispose:${contribution.package}`)}},contexts:{getClient:name=>name==='session'?{identity:caller=>caller.identity}:undefined}})
  root.provide('connection',{rpc:{call:(...args)=>request(...args)}})
  const services={get:name=>ctx.get(name),has:name=>ctx.get(name)!==undefined}
  return {ctx,services,trace,externals:{'@xharness/cordis':Core},setRequest(fn){request=fn},dispose(){return root.fiber.dispose()}}
}
const strictString = {mode: 'strict', schema: {parse: value => {if(typeof value !== 'string') throw new Error('string required'); return value}}}
const descriptor = (name='echo') => ({namespace:'demo', method:name, invocation:{kind:'direct'}, parameters:[{wire:'value', codec:strictString}], result:strictString})
for (const label of ['legacy', 'source']) {
  test(`${label}: gateway direct/scoped codecs, cancellation, mount rollback and withdrawn closure`, async () => {
    const state = gatewayContext()
    const api = label === 'legacy' ? legacy('api-gateway', {}, state.externals) : sourceModule('api-gateway', {}, state.externals)
    api.apply(state.ctx); const remote = state.services.get('remote')
    const dispose = await remote.$mount({package:'test', descriptors:[descriptor(), {...descriptor('scoped'), invocation:{kind:'context', context:'session',wire:'sessionId',codec:strictString}}]})
    const demo = state.services.get('remote.demo')
    assert.equal((await demo.echo('hello')).value, 'hello')
    await assert.rejects(demo.echo(1), /rejected "value"/)
    await assert.rejects(demo.echo(), /expected 1 argument/)
    state.setRequest(async (_route, endpoint, params, signal) => {
      assert.equal(endpoint,'demo/scoped'); assert.equal(params.args.sessionId,'sid'); assert.equal(signal.aborted,false)
      return {ok:true,value:params.args.value}
    })
    assert.equal((await demo.scoped('context')).value, 'context')
    await assert.rejects(remote.$mount({package:'duplicate',descriptors:[descriptor()]}), /already mounted/)
    await assert.rejects(remote.$mount({package:'invalid',descriptors:[{...descriptor('bad'), result:{mode:'opaque'}}]}), /no strict codec/)
    const held = demo.echo
    await dispose(); assert.equal(state.services.has('remote.demo'),false)
    const result = await held('late'); assert.equal(result.ok,false); assert.match(result.error.message,/no longer mounted/)
    assert.deepEqual(state.trace,['mount:test','dispose:test'])
  })
  test(`${label}: gateway duplicate listeners, exception containment and carrier/result failures`, async () => {
    const state = gatewayContext(); const api = label === 'legacy' ? legacy('api-gateway', {console:{error(){}}}, state.externals) : sourceModule('api-gateway', {console:{error(){}}}, state.externals)
    api.apply(state.ctx); const remote = state.services.get('remote'); let delivered = 0
    const listener = () => delivered++
    const off = remote.$on('event',listener); remote.$on('event',listener); remote.$on('event',()=>{throw new Error('listener')}); remote.$on('event',async()=>{throw new Error('listener async')})
    remote.$dispatch('event',[]); assert.equal(delivered,2); off(); remote.$dispatch('event',[]); assert.equal(delivered,3)
    const dispose = await remote.$mount({package:'calls',descriptors:[{...descriptor(),cancellation:{}}]}); const demo=state.services.get('remote.demo')
    const abort = new AbortController(); abort.abort(); state.setRequest(async(_r,_e,_p,signal)=>{assert.equal(signal.aborted,true);throw new Error('offline')})
    const failure = await demo.echo('x',abort.signal); assert.equal(failure.ok,false); assert.match(failure.error.message,/offline/)
    state.setRequest(async()=>({ok:true,value:5})); const rejected=await demo.echo('x'); assert.equal(rejected.ok,false); assert.match(rejected.error.message,/rejected "result"/)
    await dispose(); await Promise.resolve()
  })
}

function downloadContext() {
  let controller; let listener; let dispose; let seat
  return {
    ctx: {provide(_name,value){controller=value}, effect(effect){dispose=effect()}, locale:{register(){return ()=>{}}}, on(_event,fn){listener=fn}, slots:{inject(_seat,fn){fn()},register(spec,component){seat={spec,component}}}},
    get controller(){return controller}, get listener(){return listener}, get dispose(){return dispose}, get seat(){return seat},
  }
}
for (const label of ['legacy', 'source']) {
  test(`${label}: log export coalesces requests, dismiss preserves success, no late work after dispose`, async () => {
    let resolve; let count=0; const requests=[]; const downloads=[]
    const globals={fetch:(url,init)=>{count++;requests.push({url:String(url),init});return new Promise(r=>{resolve=r})}, document:{querySelector:()=>({}),createElement:()=>({set href(value){downloads.push(value)},set download(value){downloads.push(value)},click(){downloads.push('click')}})}, location:{origin:'https://harness.example'}}
    const api=label==='legacy'?legacy('session-log-export',globals,viewExternals):sourceModule('session-log-export',globals,viewExternals)
    const state=downloadContext(); api.apply(state.ctx)
    const a=state.controller.download('a/b'); const b=state.controller.download('a/b'); assert.equal(a,b); assert.equal(count,1)
    assert.equal(state.controller.store.getSnapshot().bySession['a/b'].status,'downloading')
    state.controller.dismiss('a/b'); resolve({ok:true}); await a
    const result=state.controller.store.getSnapshot().bySession['a/b']; assert.equal(result.status,'success'); assert.equal(result.open,false)
    assert.match(requests[0].url,/sessionId=a%2Fb/); assert.equal(requests[0].init.method,'HEAD'); assert.equal(downloads[1],'dsh-session-a_b.zip')
    await state.controller.dispose(); await state.controller.download('late'); assert.equal(count,1)
  })
  test(`${label}: log export reports HTTP failure, abort drains and /export command shares controller`, async () => {
    const api=label==='legacy'?legacy('session-log-export',{fetch:async()=>({ok:false,status:403,text:async()=> 'denied'})},viewExternals):sourceModule('session-log-export',{fetch:async()=>({ok:false,status:403,text:async()=> 'denied'})},viewExternals)
    const state=downloadContext(); api.apply(state.ctx)
    state.listener('s','ignored',{kind:'success'}); assert.equal(state.controller.store.getSnapshot().bySession.s,undefined)
    state.listener('s','export',{kind:'success'}); await new Promise(r=>setTimeout(r,1))
    const result=state.controller.store.getSnapshot().bySession.s; assert.equal(result.status,'error'); assert.match(result.error,/HTTP 403 denied/)
    const props={sessionId:'s',useSessionLogDownload:select=>select(state.controller.store.getSnapshot()),t:key=>key,request:()=>{},dismiss:()=>{}}
    const tree=state.seat.component(props); assert.equal(tree.props.children[0].props.disabled,false)
    await state.controller.dispose()
  })
}

function localeApi(label, globals={}) {return label==='legacy'?legacy('client-locale',globals,viewExternals):sourceModule('client-locale',globals,viewExternals)}
for (const label of ['legacy', 'source']) {
  test(`${label}: locale dictionary fallback, stable bind, revisions and ownership disposer`, () => {
    const api=localeApi(label);const emitted=[];const locale=new api.LocaleRuntime({emit:(...args)=>emitted.push(args),effect:fn=>fn()})
    assert.equal(locale.getLocale().active,'en')
    const off=locale.register('feature',{en:{hello:'Hello {name}'},zh:{hello:'你好 {name}'}})
    const commonOff=locale.register('common',{en:{ok:'OK'},zh:{ok:'确定'}})
    const t=locale.bind('feature'); assert.equal(locale.bind('feature'),t); assert.equal(t('hello',{name:'User'}),'Hello User');assert.equal(t('ok'),'OK');assert.equal(t('unknown'),'unknown')
    let changes=0; const unsubscribe=locale.subscribe(()=>changes++)
    locale.setLocale('zh');assert.equal(t('hello',{name:'用户'}),'你好 用户');assert.equal(changes,1);assert.equal(emitted.length,1)
    locale.setLocale('zh');assert.equal(changes,1)
    assert.throws(()=>locale.setLocale('bogus'),/not registered/)
    assert.throws(()=>locale.register('feature','zh',{}),/already has locale/)
    off();const revision=locale.getLocale().revision;off();assert.equal(locale.getLocale().revision,revision);assert.equal(t('hello'),'hello')
    commonOff();unsubscribe();assert.equal(locale.getSnapshot(),locale.getLocale())
  })
  test(`${label}: locale durable adoption and current-language selection still persist`, () => {
    const api=localeApi(label);let notify;const writes=[];let value={preference:'zh'}
    const host={getSnapshot:()=>({value}),subscribe:fn=>{notify=fn;return()=>{}},set:(key,val)=>{writes.push([key,val]);return Promise.resolve()}}
    const locale=new api.LocaleRuntime({emit(){},effect:fn=>fn()},host)
    assert.equal(locale.getLocale().active,'zh');locale.setLocale('zh');assert.deepEqual(writes,[['preference','zh']])
    value={};notify();assert.equal(locale.getLocale().active,'en');assert.equal(writes.length,1)
  })
}

for (const label of ['legacy', 'source']) {
  test(`${label}: gateway partial namespace installation rollback leaves no service`, async () => {
    const state = gatewayContext();const originalPlugin=state.ctx.plugin;let starts=0
    state.ctx.plugin = plugin => { if(++starts===2) throw new Error('namespace failed'); return originalPlugin(plugin) }
    const api=label==='legacy'?legacy('api-gateway',{},state.externals):sourceModule('api-gateway',{},state.externals)
    api.apply(state.ctx); const remote=state.services.get('remote')
    await assert.rejects(remote.$mount({package:'partial',descriptors:[descriptor(),{...descriptor(),namespace:'other'}]}),/namespace failed/)
    assert.equal(state.services.has('remote.demo'),false); assert.deepEqual(state.trace,['mount:partial','dispose:partial'])
    assert.equal(state.services.has('remote'),true)
  })
  test(`${label}: log export abort cancels in-flight HTTP and waits for settlement`, async () => {
    let signal
    const globals={fetch:(_url,init)=>{signal=init.signal;return new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true})})}}
    const api=label==='legacy'?legacy('session-log-export',globals,viewExternals):sourceModule('session-log-export',globals,viewExternals)
    const state=downloadContext();api.apply(state.ctx); const work=state.controller.download('active')
    await state.controller.dispose();await work;assert.equal(signal.aborted,true)
    assert.equal(state.controller.store.getSnapshot().bySession.active.status,'downloading')
  })
  test(`${label}: locale apply owns document language, preference row and initial snapshot sync`, () => {
    const document={querySelector:()=>({}),documentElement:{lang:'before'}}
    const api=localeApi(label,{window:{},navigator:{languages:['fr-FR','zh-Hans-CN'],language:'en-US'},document})
    let runtime;let row;let sync;let installed
    const host={getSnapshot:()=>({value:{}}),subscribe:()=>()=>{},set:()=>Promise.resolve()}
    api.apply({effect:fn=>fn(),emit:(_name,snapshot)=>sync?.(snapshot),on:(_name,fn)=>{sync=fn},provide:(_name,value)=>{runtime=value},settingsScope:{bind:()=>host},slots:{installLocale:value=>{installed=value},inject:(_name,fn)=>fn(),register:(spec,component)=>{row={spec,component}}}})
    assert.equal(runtime.getLocale().active,'zh');assert.equal(installed,runtime);assert.equal(document.documentElement.lang,'zh-CN')
    const rows=[]; const injection=row.spec.inject({sync:(...args)=>rows.push(args)})
    assert.equal(rows[0][0],'zh');assert.equal(rows[0][1].length,2)
    injection.setLocale('en');assert.equal(document.documentElement.lang,'en');assert.equal(rows.at(-1)[0],'en')
    const tree=row.component({t:key=>key,setLocale:()=>{},useStore:select=>select({active:'en',options:[{id:'en',label:'English'}]})})
    assert.equal(tree.type,'div');assert.equal(tree.props.children[1].type,'Menu');assert.equal(tree.props.children[1].props.selectedId,'en')
  })
}

function cordisApi(label, globals = {}) {
  class Context extends Core.Context {
    constructor(services = {}, inject = {}) {
      super()
      for (const [name,value] of Object.entries(services)) this.provide(name,value)
      this.fiber.inject=inject
    }
  }
  const external={...viewExternals, '@xharness/cordis':Core, '@xharness/dsh-client-modules/client':current}
  const options={setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, ...globals}
  return {Context, api:label==='legacy'?legacy('cordis-client-runner',options,external):sourceModule('cordis-client-runner',options,external)}
}
for (const label of ['legacy','source']) {
  test(`${label}: dynamic closure preserves global redirects, JSON host seat and style cleanup`, async () => {
    const tags=[];const errors=[];const invoked=[]
    const document={head:{append:tag=>tags.push(tag)},createElement:()=>({dataset:{},remove(){this.removed=true}})}
    const {api}=cordisApi(label,{document,console:{...console,error:(...args)=>errors.push(args),log(){}}})
    const styles=new api.DynamicCordisStyles('plugin')
    const plugin=await api.evaluateClientHalf('plugin', "styles.insert('body{}'); console.error('example'); await host.call('ping'); return {inject:['slots'],apply(ctx){return ctx}}", {invoke:(method,args)=>{invoked.push([method,args]);return Promise.resolve(null)},noteError:text=>errors.push(text)},styles)
    assert.equal(typeof plugin.apply,'function');assert.deepEqual(invoked,[['ping',null]]);assert.equal(styles.count,1);assert.equal(tags[0].dataset.dyn,'plugin')
    assert.equal(errors.includes('example'),true);styles.dispose();assert.equal(tags[0].removed,true);assert.equal(styles.count,0)
    for (const code of ["fetch('url');return ctx=>{}", "setTimeout(()=>{},1);return ctx=>{}", "require('fs');return ctx=>{}", "harness.handle;return ctx=>{}"]) {
      await assert.rejects(api.evaluateClientHalf('p',code,{invoke:async()=>null,noteError(){}},styles),/HOST|host|modules|timer/i)
    }
    await assert.rejects(api.evaluateClientHalf('p','',{invoke:async()=>null,noteError(){}},styles),/forget.*return/)
    await assert.rejects(api.evaluateClientHalf('p','return 7',{invoke:async()=>null,noteError(){}},styles),/return.*plugin/)
    await assert.rejects(api.evaluateClientHalf('p','return <div/>',{invoke:async()=>null,noteError(){}},styles),/plain JavaScript|Unexpected/)
  })
  test(`${label}: dynamic guard enforces declared seats, traced receivers, owned theme and Context withholding`, () => {
    const errors=[];const ledger=[];const registered=[];const disposed=[]
    const {api,Context}=cordisApi(label)
    const slots={spec:()=>({kind:'single'}),register(options,component){registered.push([this,options,component]);return()=>disposed.push('slot')}}
    const theme={overrideTokens(source,tokens){registered.push([source,tokens]);return()=>disposed.push('theme')}}
    const ctx=new Context({slots,theme,private:{getContext:()=>new Context()}},{slots:{},theme:{}})
    const facade=api.dynamicCordisContext(ctx,{pkg:{pluginId:'p',packageId:'v',pluginRunId:'run'},ledger,claim:component=>registered.push(component),allocatePriority:()=>-1,reportFailure:error=>errors.push(error)})
    const component=()=>null;const off=facade.slots.register({name:'tool.view.cordis',key:'self'},component)
    assert.equal(registered[0][0],slots);assert.equal(registered[0][1].key,'p.v');assert.equal(registered[0][1].priority,-1);assert.equal(ledger[0].slot,'tool.view.cordis');off()
    facade.theme.overrideTokens('impersonator',{color:'red'});assert.equal(registered.at(-1)[0],'p.v')
    assert.throws(()=>facade.private,/not declared/);assert.throws(()=>facade.timeout(()=>{},1),/timer/);assert.throws(()=>{facade.slots=slots},/read-only/)
    assert.throws(()=>facade.get('private').getContext(),/returned a cordis Context/)
    assert.throws(()=>facade.slots.register({name:'tool.view.cordis',key:'other'},component),/only accepts/)
    assert.equal(errors.length,5);assert.equal('slots' in facade,true);assert.equal('timeout' in facade,false)
  })
  test(`${label}: inspect query cancellation, duplicate admission and settlement preserve request correlation`, async () => {
    const {api}=cordisApi(label,{console:{...console,error(){}}});const synced=[];const resolutions=[];let finish;let seenSignal
    const registry=new api.ClientCordisInspectRegistry({sync:async manifests=>synced.push(manifests),resolve:async (...args)=>resolutions.push(args)})
    const off=registry.register({manifest:{id:'test',description:'fixture',methods:[{name:'query',description:'fixture',inputSchema:{},outputSchema:{}}]},query:(_method,_input,context)=>{seenSignal=context.signal;return new Promise(resolve=>finish=resolve)}})
    await new Promise(r=>setTimeout(r,1));assert.equal(synced.length,1)
    const request={requestId:'req',agentId:'session',provider:'test',method:'query'};const work=registry.query(request)
    await registry.query(request);registry.close('req');assert.equal(seenSignal.aborted,true);finish({value:1});await work
    assert.equal(resolutions.length,0) // A host-resolved query must not be answered again after cancellation.
    await registry.query({...request,requestId:'missing',provider:'none'});assert.equal(resolutions.at(-1)[2].reason,'provider-missing')
    off();off();await new Promise(r=>setTimeout(r,1));assert.equal(synced.at(-1).length,0)
  })
  test(`${label}: lifecycle coalesces same activation, replacement and stale retract; load errors remain classified`, async () => {
    const registrations=new Map();const entries=new Map();const removed=[];const invalidated=[];let nextId=0;let watcher
    const {api,Context}=cordisApi(label,{__ModuleLoader__:{load:r=>registrations.set(r.id,r.factory())}})
    const ctx=new Context({slots:{}},{})
    const loader={create:async({name})=>{const id=String(++nextId);const plugin=registrations.get(name);const fiber={inject:{},await:async()=>plugin.apply(ctx)};entries.set(id,{fiber});return id},resolve:id=>entries.get(id),remove:async id=>{removed.push(id);entries.delete(id)}}
    const env={ctx,loader,modules:{invalidate:id=>invalidated.push(id)},slots:{onEntryError:fn=>{watcher=fn;return()=>{watcher=null}}},invoke:async()=>null,reportRenderFailure(){},reportGuardFailure(){}}
    const runner=new api.DynamicCordisPackageRunner(env)
    const half={pluginId:'p',packageId:'v1',pluginRunId:'r1',agentId:'s',name:'fixture',code:'return ctx=>{}'}
    const [a,b]=await Promise.all([runner.load(half),runner.load(half)]);assert.equal(a.ok,true);assert.equal(b.ok,true);assert.equal(nextId,1)
    const snapshot=runner.getSnapshot();assert.equal(runner.getSnapshot(),snapshot)
    await runner.load({...half,packageId:'v2',pluginRunId:'r2'});assert.equal(nextId,2);assert.deepEqual(removed,['1'])
    runner.retract('p','r1');await new Promise(r=>setTimeout(r,1));assert.equal(runner.isLoaded('p'),true)
    runner.retract('p','r2');await new Promise(r=>setTimeout(r,1));assert.equal(runner.isLoaded('p'),false)
    const fail=await runner.load({...half,code:'throw new Error("bad")'});assert.equal(fail.ok,false);assert.equal(fail.cause,'evaluate')
    const activate=await runner.load({...half,code:'return ctx=>{throw new Error("activate")}' });assert.equal(activate.ok,false);assert.equal(activate.cause,'activate')
    await runner.dispose();assert.equal(watcher,null);assert.equal(registrations.has('dyn/p'),true);assert.equal(invalidated.includes('dyn/p'),true)
  })
}

function clockFixture() {
  let now=0; let nextId=0; const tasks=new Map()
  const schedule=(callback, delay, args, repeat)=>{const id=++nextId;tasks.set(id,{callback,at:now+delay,args,repeat,delay});return id}
  return {
    get size(){return tasks.size},get now(){return now},
    globals:{Date:{now:()=>now},setTimeout:(callback,delay,...args)=>schedule(callback,delay,args,false),setInterval:(callback,delay,...args)=>schedule(callback,delay,args,true),clearTimeout:id=>tasks.delete(id),clearInterval:id=>tasks.delete(id)},
    tick(ms){const end=now+ms;for(;;){let earliest;for(const pair of tasks)if(pair[1].at<=end&&(!earliest||pair[1].at<earliest[1].at))earliest=pair;if(!earliest)break;const[id,task]=earliest;now=task.at;if(task.repeat)task.at+=task.delay;else tasks.delete(id);task.callback(...task.args)}now=end},
  }
}
function timerFixture(label) {
  const clock=clockFixture();const {api,Context}=cordisApi(label,clock.globals)
  const ctx=new Context()
  return {clock,ctx,timer:new api.ClientTimerService(ctx),get effectCount(){return ctx.fiber.getEffects().filter(item=>['ctx.timeout()','ctx.interval()','ctx.throttle()','ctx.debounce()'].includes(item.label)).length},dispose(){return ctx.fiber.dispose()}}
}
for (const label of ['legacy','source']) {
  test(`${label}: callback and awaited timeouts release timers and fiber effects on completion/cancellation`,async()=>{
    const f=timerFixture(label);let hits=0
    const cancel=f.timer.timeout(()=>hits++,5);cancel();cancel();f.clock.tick(10);assert.equal(hits,0);assert.equal(f.effectCount,0)
    f.timer.timeout(()=>hits++,5);f.clock.tick(5);assert.equal(hits,1);assert.equal(f.effectCount,0)
    const wait=f.timer.timeout(5);f.clock.tick(5);await wait;assert.equal(f.clock.size,0);assert.equal(f.effectCount,0)
    const abandoned=f.timer.timeout(5);const rejected=assert.rejects(abandoned,/Context has been disposed/);f.dispose();await rejected;f.clock.tick(5);assert.equal(f.clock.size,0);assert.equal(f.effectCount,0)
  })
  test(`${label}: callback and iterator intervals preserve ticks, return/throw and context disposal`,async()=>{
    const f=timerFixture(label);let hits=0;const off=f.timer.interval(()=>hits++,3);f.clock.tick(7);off();f.clock.tick(6);assert.equal(hits,2)
    const ticks=f.timer.interval(3);assert.equal(ticks[Symbol.asyncIterator](),ticks);const first=ticks.next();f.clock.tick(3);assert.equal((await first).done,false)
    const pending=ticks.next();await ticks.return('done');assert.equal((await pending).done,true);assert.equal((await ticks.next()).value,'done')
    const failing=f.timer.interval(3);const error=new Error('failure');const rejected=assert.rejects(failing.next(),/failure/);await failing.throw(error);await rejected;await assert.rejects(failing.next(),/failure/)
    const closed=f.timer.interval(3);const disposed=assert.rejects(closed.next(),/Context has been disposed/);f.dispose();await disposed;await assert.rejects(closed.next(),/Context has been disposed/)
    assert.equal(f.clock.size,0);assert.equal(f.effectCount,0)
  })
  test(`${label}: throttle/debounce preserve argument tuples, trailing policy and cleanup`,()=>{
    const f=timerFixture(label);const rows=[];const throttle=f.timer.throttle((...args)=>rows.push(args),10)
    throttle('first',1);f.clock.tick(2);throttle('second',2);f.clock.tick(2);throttle('third',3);assert.deepEqual(rows,[['first',1]]);f.clock.tick(6);assert.deepEqual(rows,[['first',1],['third',3]])
    f.clock.tick(1);throttle('discard');throttle.dispose();f.clock.tick(20);assert.equal(rows.length,2)
    const leadingOnly=f.timer.throttle((...args)=>rows.push(args),10,true);leadingOnly('lead');f.clock.tick(1);leadingOnly('no-tail');f.clock.tick(20);assert.equal(rows.at(-1)[0],'lead')
    const debounce=f.timer.debounce((...args)=>rows.push(args),5);debounce('old');f.clock.tick(2);debounce('new',4);f.clock.tick(5);assert.deepEqual(rows.at(-1),['new',4]);debounce('cancel');debounce.dispose();debounce('after-close');f.clock.tick(10);assert.deepEqual(rows.at(-1),['new',4])
    f.dispose();assert.equal(f.clock.size,0);assert.equal(f.effectCount,0)
  })
  test(`${label}: orchestration coalesces per plugin and preserves Host -> source -> load -> settlement order`,async()=>{
    const {api}=cordisApi(label);const trace=[];let hostDone
    const source={pluginId:'p',packageId:'v',pluginRunId:'run',name:'fixture',code:'return ctx=>{}'}
    const env={runner:{load:async half=>{trace.push(['load',half]);return {ok:true,pluginRunId:'run',waitingFor:['slots']}}},host:{runHostHalf:async(...args)=>{trace.push(['host',args]);return new Promise(resolve=>hostDone=resolve)},getClientCode:async(...args)=>{trace.push(['source',args]);return source},settleUserRun:async(...args)=>{trace.push(['settle',args]);return {ok:true}},resolveRequestRun:async(...args)=>{trace.push(['answer',args]);return {accepted:true}}}}
    const o=new api.CordisRunOrchestrator(env);const plan={agentId:'s',pluginId:'p',packageId:'v',mode:'run',hasClientHalf:true};const work=o.startUserRun(plan);assert.equal(o.startUserRun(plan),work);assert.equal(o.activeRuns.getSnapshot().get('p').phase,'orchestrating');assert.deepEqual(trace.map(row=>row[0]),['host'])
    hostDone({ok:true,pluginRunId:'run',startedHere:true});await work;assert.deepEqual(trace.map(row=>row[0]),['host','source','load','settle']);assert.equal(trace[0][1][4],null);assert.equal(trace[0][1][5],false);assert.deepEqual(Array.from(trace[3][1][2].waitingFor),['slots']);assert.equal(o.activeRuns.getSnapshot().size,0)
    env.host.runHostHalf=async()=>{trace.push(['host-only']);return {ok:true,pluginRunId:'run',startedHere:true}};trace.length=0;await o.startUserRun({...plan,hasClientHalf:false});assert.deepEqual(trace.map(row=>row[0]),['host-only'])
  })
  test(`${label}: approvals stay authoritative across missed events, rejection, remote settlement and reconnect inventory`,async()=>{
    const {api}=cordisApi(label);const answers=[];let calls=0;const env={runner:{load:async()=>({ok:true,pluginRunId:'run'})},host:{runHostHalf:async()=>{calls++;return{ok:true,pluginRunId:'run',startedHere:true}},getClientCode:async()=>({pluginId:'p',packageId:'v',pluginRunId:'run',name:'fixture',code:'return ctx=>{}'}),resolveRequestRun:async(...args)=>{answers.push(args);return{accepted:true}},settleUserRun:async()=>({ok:true})}}
    const o=new api.CordisRunOrchestrator(env);const request={requestId:'req',agentId:'s',pluginId:'p',packageId:'v',mode:'run',name:'fixture',purpose:'test',requiresApproval:true}
    o.open(request);assert.equal(o.activeRuns.getSnapshot().get('p').phase,'awaiting-approval');o.close('req');await o.approve('req',true);assert.equal(calls,0)
    o.open(request);await o.decline('req');await o.decline('req');assert.equal(calls,0);assert.equal(answers.length,1);assert.equal(answers[0][1].reason,'rejected')
    const rows=[{agentId:'s',pluginId:'p',packages:[{packageId:'v',name:'fixture',purpose:'test'}],latestRun:{approvalRequestId:'reconnect',packageId:'v',mode:'run',status:'awaiting-approval'}}];o.reconcileApprovals(rows);assert.equal(o.activeRuns.getSnapshot().get('p').requestId,'reconnect');const snapshot=o.activeRuns.getSnapshot();o.reconcileApprovals(rows);assert.equal(o.activeRuns.getSnapshot(),snapshot);o.reconcileApprovals([]);assert.equal(o.activeRuns.getSnapshot().size,0)
    o.open({...request,requestId:'approved'});await o.approve('approved',true);assert.equal(calls,1);assert.equal(answers.at(-1)[0],'approved');assert.equal(answers.at(-1)[1].ok,true)
  })
  test(`${label}: Host, Client and settlement failures remain separate and clear per-plugin activity`,async()=>{
    const {api}=cordisApi(label,{console:{...console,error(){}}});const answered=[];const env={runner:{load:async()=>({ok:false,cause:'activate',message:'bad apply'})},host:{runHostHalf:async()=>({ok:false,message:'host failed'}),getClientCode:async()=>({pluginId:'p',packageId:'v',pluginRunId:'run',name:'fixture',code:'return ctx=>{}'}),resolveRequestRun:async(...args)=>{answered.push(args);return{accepted:true}},settleUserRun:async()=>({ok:false,message:'settle failed'})}}
    const o=new api.CordisRunOrchestrator(env);const request={requestId:'req',agentId:'s',pluginId:'p',packageId:'v',mode:'run',name:'fixture',purpose:'test',requiresApproval:true};o.open(request);await o.approve('req',false);assert.equal(answered[0][1].reason,'host-half-failed');assert.equal(o.lastRunError.getSnapshot().get('p').reason,'host-half-failed');assert.equal(o.activeRuns.getSnapshot().size,0)
    env.host.runHostHalf=async()=>({ok:true,pluginRunId:'run',startedHere:false});o.open({...request,requestId:'client'});await o.approve('client',false);assert.equal(answered.at(-1)[1].reason,'client-half-failed');assert.equal(answered.at(-1)[1].startedHere,false);assert.equal(answered.at(-1)[1].message,'activate: bad apply');assert.equal(o.lastRunError.getSnapshot().get('p').reason,'client-half-failed')
    env.runner.load=async()=>({ok:true,pluginRunId:'run'});await o.startUserRun({agentId:request.agentId,pluginId:request.pluginId,packageId:request.packageId,mode:request.mode,hasClientHalf:true});assert.equal(o.lastRunError.getSnapshot().get('p').message,'settle failed');assert.equal(o.activeRuns.getSnapshot().size,0)
  })
}

test('source: structured inspect catalogs retain baseline data without an external generator',()=>{
  const map=JSON.parse(readFileSync(join(repo,'ui/reference/master-a613970/plugins/@xharness/dsh-cordis-client-runner/client.js.map'),'utf8'))
  for(const [entry,keys]of [['api-catalog',['SERVICE_API','EVENT_API','TYPE_API','INHERITED_CTX_API']],['slot-catalog',['CLIENT_NOTES','CLIENT_SLOT_API']]]){
    const baseline=map.sourcesContent[map.sources.findIndex(source=>source.endsWith(`/${entry}.js`))];assert.equal(typeof baseline,'string')
    const module={exports:{}};const compiled=ts.transpileModule(baseline,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
    vm.runInNewContext(`(function(module,exports){${compiled}\n})`,{})(module,module.exports)
    const current=sourceModule('cordis-client-runner',{},viewExternals,entry)
    for(const key of keys)assert.equal(JSON.stringify(current[key]),JSON.stringify(module.exports[key]),`${entry}.${key} catalog mismatch`)
  }
})

function registryFixture(label) {
  const ctx=new Core.Context(),warnings=[]
  ctx.logger.warn=value=>warnings.push(value)
  const external={'@xharness/cordis':Core}
  const api=label==='legacy'?legacy('typert-registry',{},external):sourceModule('typert-registry',{},external)
  api.apply(ctx)
  return {registry:ctx.get('typert'),ctx,warnings,dispose(){return ctx.fiber.dispose()}}
}
const registryDescriptor=(name='echo')=>({id:`test#demo/${name}`,service:'demo',namespace:'demo',method:name,invocation:{kind:'direct'},parameters:[{name:'value',wire:'value',source:'json',codec:{mode:'strict',typeSymbol:'string',schema:zod.z.string()}}],result:{mode:'strict',typeSymbol:'string',schema:zod.z.string()}})
const registryContribution=(packageName='test',descriptors=[registryDescriptor()])=>({package:packageName,face:'client',schemas:[{name:'Value',schema:zod.z.string()}],model:{services:[],events:[],objects:[]},invocations:descriptors})
for(const label of ['legacy','source']){
  test(`${label}: reflection and invocation registration are atomic, ordered and fiber-owned`,async()=>{
    const f=registryFixture(label);const r=f.registry;const changes=[];const off=r.local.subscribe(change=>changes.push(change.key));const contribution=registryContribution();const dispose=r.register(contribution)
    assert.equal(r.get('test#Value').schema,contribution.schemas[0].schema);assert.equal(r.getPackage('test','client').model,contribution.model);assert.equal(r.list({face:'host'}).length,0);assert.equal(r.listPackages({package:'test'}).length,1);assert.equal(r.local.get('demo/echo'),contribution.invocations[0]);assert.equal(r.local.hasSeen('demo/echo'),true)
    assert.throws(()=>r.register(registryContribution()),/already registered/);assert.throws(()=>r.register({...registryContribution('other'),invocations:[registryDescriptor('new'),registryDescriptor()]}),/already registered/);assert.equal(r.getPackage('other','client'),undefined);assert.equal(r.local.get('demo/new'),undefined)
    assert.throws(()=>r.resolve('missing'),/invalid schema key/);assert.throws(()=>r.resolve('test#Absent'),/contributes no schema/);assert.throws(()=>r.resolve('absent#Value'),/no registered contribution/)
    assert.deepEqual(JSON.parse(JSON.stringify(r.toJSONSchema('test#Value'))),{$schema:'https://json-schema.org/draft/2020-12/schema',type:'string'})
    await dispose();await dispose();assert.equal(r.list().length,0);assert.equal(r.local.get('demo/echo'),undefined);assert.equal(r.local.hasSeen('demo/echo'),true);assert.deepEqual(changes,['demo/echo','demo/echo']);await off();await f.dispose()
  })
  test(`${label}: strict invocation validation rejects invalid scope, cancellation, lookup and batch identities before mutation`,async()=>{
    const f=registryFixture(label);const r=f.registry;const base=registryDescriptor();const bad=[{...base,id:''},{...base,namespace:'/'},{...base,parameters:[base.parameters[0],base.parameters[0]]},{...base,cancellation:{parameter:'not-signal'}},{...base,scope:{context:'agent',wire:'agentId'}},{...base,parameters:[{...base.parameters[0],source:'lookup'}]},{...base,result:{mode:'strict',typeSymbol:'string',schema:{}}},{...base,invocation:{kind:'context',context:'agent',wire:'value',codec:base.result}}]
    for(const descriptor of bad)assert.throws(()=>r.register(registryContribution('bad',[descriptor])),/typert:/)
    assert.throws(()=>r.register({...registryContribution('bad'),schemas:[{name:'Same',schema:zod.z.string()},{name:'Same',schema:zod.z.string()}]}),/already registered/);assert.throws(()=>r.register({...registryContribution('bad'),face:'none'}),/invalid face/);assert.equal(r.listPackages().length,0);assert.equal(r.local.list().length,0)
    const remoteOff=r.remotes.register({package:'remote',descriptors:[base]});assert.throws(()=>r.remotes.register({package:'remote',descriptors:[]}),/already registered/);assert.equal(r.remotes.get('demo/echo'),base);await remoteOff();assert.equal(r.remotes.list().length,0);await f.dispose()
  })
  test(`${label}: lookup override restores defaults and immutable wire declarations survive provider unload`,async()=>{
    const f=registryFixture(label);const r=f.registry;const changes=[];r.lookups.subscribe(change=>changes.push(change.key));r.lookups.subscribe(()=>{throw new Error('observer')})
    const configured=r.lookups.configure('agent',id=>`override:${id}`);assert.equal(r.lookups.get('agent'),undefined)
    const provider={parameter:'agent',wire:'agentId',hostTypeSymbol:'Agent',wireTypeSymbol:'string',resolve:id=>`default:${id}`};const registered=r.lookups.register('agent',provider);assert.equal(await r.lookups.get('agent').resolve('s'),'override:s');assert.throws(()=>r.lookups.configure('agent',id=>id),/already configured/);assert.throws(()=>r.lookups.register('agent',provider),/already registered/)
    await configured();assert.equal(await r.lookups.get('agent').resolve('s'),'default:s');await registered();assert.equal(r.lookups.get('agent'),undefined);assert.deepEqual(Array.from(r.lookups.keys()),[]);assert.equal(r.lookups.definitions()[0].wire,'agentId');assert.throws(()=>r.lookups.register('agent',{...provider,wire:'differentId'}),/changed its wire declaration/)
    const again=r.lookups.register('agent',provider);await again();assert.equal(changes.length,6);assert.equal(f.warnings.length,12);await f.dispose()
  })
  test(`${label}: scoped Host/Client Context ownership and configured policies remain separate`,async()=>{
    const f=registryFixture(label);const r=f.registry;const override=new Core.Context().extend({identity:'override'});const original=new Core.Context().extend({identity:'original'});const configured=r.contexts.configureHost('agent',()=>override);assert.equal(r.contexts.getHost('agent'),undefined)
    const registered=r.contexts.registerHost('agent',{wire:'agentId',wireTypeSymbol:'string',resolve:()=>original});assert.equal(await r.contexts.getHost('agent').resolve('s'),override);const bound=r.contexts.registerClient('agent',{identity:ctx=>ctx.identity});assert.equal(r.contexts.getClient('agent').identity({identity:'s'}),'s');assert.throws(()=>r.contexts.registerClient('agent',{identity:()=>undefined}),/already registered/)
    await configured();assert.equal(await r.contexts.getHost('agent').resolve('s'),original);await bound();assert.equal(r.contexts.getClient('agent'),undefined);await registered();assert.equal(r.contexts.getHost('agent'),undefined);await f.dispose()
  })
  test(`${label}: selected Remote contributions mount in order and unwind failures in reverse`,async()=>{
    const api=label==='legacy'?legacy('api-remotes'):sourceModule('api-remotes');const trace=[];const ctx={remote:{$mount:async contribution=>{trace.push(['mount',contribution.package]);return async()=>trace.push(['dispose',contribution.package])}}};const dispose=await api.apply(ctx);assert.equal(trace.length,7);const mounted=trace.map(row=>row[1]);await dispose();assert.deepEqual(trace.slice(7).map(row=>row[1]),[...mounted].reverse())
    trace.length=0;ctx.remote.$mount=async contribution=>{if(trace.length===3)throw new Error('mount');trace.push(['mount',contribution.package]);return async()=>trace.push(['dispose',contribution.package])};await assert.rejects(api.apply(ctx),/mount/);assert.deepEqual(trace.slice(3).map(row=>row[1]),trace.slice(0,3).map(row=>row[1]).reverse())
  })
}

test('source: selected Remote descriptor metadata and real Zod codecs match the shipped baseline',async()=>{
  const collect=async api=>{const rows=[];await api.apply({remote:{$mount:async contribution=>{rows.push(contribution);return async()=>{}}}});return rows}
  // Zod uses a page-global error configuration; both paths must see the same policy.
  const oldRows=await collect(legacy('api-remotes',{__zod_globalConfig:zod.z.core.config()}));const newRows=await collect(sourceModule('api-remotes',{__zod_globalConfig:zod.z.core.config()}))
  const metadata=value=>JSON.stringify(value,(key,item)=>key==='schema'?'zod-schema':item)
  assert.equal(metadata(newRows),metadata(oldRows));const corpus=[undefined,null,false,true,'', 'text',0,1,[],{}, {value:'a'}, {agentId:'s',message:'a'}, {ok:true,pluginRunId:'run'}, {kind:'success',text:'ready'},()=>{}, {nested:[null,'a',3,{done:true}]}];let codecCount=0
  for(let row=0;row<oldRows.length;row++)for(let i=0;i<oldRows[row].descriptors.length;i++){
    const pair=[oldRows[row].descriptors[i],newRows[row].descriptors[i]];const codecs=descriptor=>[descriptor.result,...descriptor.parameters.map(parameter=>parameter.codec),...(descriptor.invocation.kind==='context'?[descriptor.invocation.codec]:[])].filter(codec=>codec.mode==='strict')
    const oldCodecs=codecs(pair[0]),newCodecs=codecs(pair[1]);for(let j=0;j<oldCodecs.length;j++){codecCount++;for(const candidate of corpus){const baseline=oldCodecs[j].schema.safeParse(candidate),source=newCodecs[j].schema.safeParse(candidate);assert.equal(source.success,baseline.success,`${pair[0].id} codec${j} acceptance`);if(source.success)assert.equal(JSON.stringify(source.data),JSON.stringify(baseline.data));else assert.equal(JSON.stringify(source.error.issues),JSON.stringify(baseline.error.issues),`${pair[0].id} codec${j} issues`)}}
  }
  assert.ok(codecCount>70)
})

function controllerApi(label, globals) {
  if(label==='source')return sourceModule('client-connection',globals,{},'controller').ConnectionController
  const code=readFileSync(join(repo,'ui/reference/master-a613970/plugins/@xharness/dsh-client-connection/client.js'),'utf8');const start=code.indexOf('//#region lib/types/client/connection.js');const end=code.indexOf('//#endregion',start);assert.ok(start>0&&end>start)
  const context={module:{exports:{}},Promise,AbortController,console,...globals};vm.runInNewContext(code.slice(start,end)+'\nmodule.exports=ConnectionController;',context);return context.module.exports
}
const drain=async()=>{for(let i=0;i<15;i++)await Promise.resolve()}
function streamsFixture() {
  const streams=[];let describes=0;let describe=async()=>({result:{ok:true,value:{version:'fixture'}}})
  const create=(channel,signal,onOpen)=>{
    let resolver;let opened=false;let done=false;const queued=[]
    const stream={channel,signal,open:onOpen,send:frame=>{if(resolver){const r=resolver;resolver=undefined;r({done:false,value:frame})}else queued.push(frame)},finish:()=>{done=true;resolver?.({done:true});resolver=undefined},[Symbol.asyncIterator](){return this},next(){if(!opened)opened=true;if(done||signal.aborted)return Promise.resolve({done:true});if(queued.length)return Promise.resolve({done:false,value:queued.shift()});return new Promise(resolve=>resolver=resolve)}}
    signal.addEventListener('abort',stream.finish,{once:true});streams.push(stream);return stream
  }
  const api={host:{describe:()=>{describes++;return describe()}},events:{mux:(_payload,signal,onOpen)=>create('mux',signal,onOpen),host:(_payload,signal,onOpen)=>create('host',signal,onOpen)}}
  return {api,streams,get describes(){return describes},setDescribe(fn){describe=fn}}
}
for(const label of ['legacy','source']){
  test(`${label}: stream controller waits for both opens, isolates sinks, starts/stops idempotently`,async()=>{
    const f=streamsFixture();const clock=clockFixture();const errors=[];const Controller=controllerApi(label,{...clock.globals,console:{warn(){},error:message=>errors.push(message)}});const states=[];const connected=[];let deliveries=0
    const controller=new Controller(f.api,{onConnected:description=>connected.push(description.version),onStateChange:state=>states.push(state),onMuxEnvelope:()=>{deliveries++;throw new Error('consumer')}},{streamOpenTimeoutMs:5,backoffBaseMs:100})
    controller.start();controller.start();await drain();assert.equal(f.describes,1);assert.equal(f.streams.length,2);assert.equal(connected.length,0);f.streams[0].open();await drain();assert.equal(connected.length,0);f.streams[1].open();await drain();assert.deepEqual(connected,['fixture']);assert.deepEqual(states,['connected'])
    f.streams[0].send({rpcId:'x',payload:{type:'fixture'}});await drain();assert.equal(deliveries,1);assert.equal(errors.length,1);assert.equal(f.describes,1);controller.stop();controller.stop();await drain();assert.equal(f.streams.every(stream=>stream.signal.aborted),true);assert.equal(f.describes,1);assert.deepEqual(states,['connected']);assert.equal(clock.size,0)
  })
  test(`${label}: stream loss repairs a generation after bounded backoff and invalidates old stream signals`,async()=>{
    const f=streamsFixture();const clock=clockFixture();const Controller=controllerApi(label,{...clock.globals,console:{warn(){},error(){}},Math:Object.assign(Object.create(Math),{random:()=>0})});const states=[];const controller=new Controller(f.api,{onStateChange:state=>states.push(state)},{streamOpenTimeoutMs:5,backoffBaseMs:10});controller.start();f.streams[0].open();f.streams[1].open();await drain();f.streams[0].finish();await drain();assert.deepEqual(states,['connected','reconnecting']);assert.equal(f.streams[1].signal.aborted,true);clock.tick(5);await drain();assert.equal(f.describes,2);assert.equal(f.streams.length,4);f.streams[2].open();f.streams[3].open();await drain();assert.deepEqual(states,['connected','reconnecting','connected']);controller.stop();await drain();assert.equal(clock.size,0)
  })
  test(`${label}: open timeout fails soft and reentrant stop suppresses stale handshake publication`,async()=>{
    const f=streamsFixture();const clock=clockFixture();const Controller=controllerApi(label,{...clock.globals,console:{warn(){},error(){}}});const connected=[];const controller=new Controller(f.api,{onStateChange:state=>{if(state==='connected')controller.stop()},onConnected:()=>connected.push('stale')},{streamOpenTimeoutMs:5});controller.start();await drain();clock.tick(5);await drain();assert.deepEqual(connected,[]);assert.equal(f.streams.every(stream=>stream.signal.aborted),true);assert.equal(clock.size,0)
  })
}

function runtimeRegion(path, names) {
  const code=readFileSync(join(repo,'ui/reference/master-a613970/plugins/@xharness/dsh-client-runtime/client.js'),'utf8');const start=code.indexOf(`//#region lib/types/client/${path}.js`);const end=code.indexOf('//#endregion',start);assert.ok(start>0&&end>start)
  const context={module:{exports:{}}};vm.runInNewContext(code.slice(start,end)+`\nmodule.exports={${names.join(',')}};`,context);return context.module.exports
}
for(const label of ['legacy','source']){
  const helpers=(path,names)=>label==='legacy'?runtimeRegion(path,names):sourceModule('client-runtime',{}, {},path)
  test(`${label}: baseline ordering preserves known positions and follows next anchors for unseen rows`,()=>{
    const {mergeOrderedBaseline}=helpers('ordered-baseline',['mergeOrderedBaseline']);const a={id:'a',version:0},b={id:'b',version:0};const fresh=[{id:'x',version:1},{id:'a',version:1},{id:'b',version:1},{id:'tail',version:1}];const merged=mergeOrderedBaseline([b,a,{id:'deleted'}],fresh,row=>row.id);assert.deepEqual(Array.from(merged,row=>row.id),['b','x','a','tail']);assert.equal(merged[2],fresh[1]);assert.equal(mergeOrderedBaseline([a],[],row=>row.id).length,0)
  })
  test(`${label}: path helpers preserve UNC/drive paths and respect POSIX home boundaries`,()=>{
    const api=helpers('workspaces/path',['resolveWorkspacePath','abbreviateHomePath']);assert.equal(api.resolveWorkspacePath('/workspace/','src/main.ts'),'/workspace/src/main.ts');for(const absolute of ['/tmp/a','C:\\tmp\\a','\\\\server\\share'])assert.equal(api.resolveWorkspacePath('/workspace',absolute),absolute);assert.equal(api.resolveWorkspacePath(undefined,'relative'),'relative');assert.equal(api.abbreviateHomePath('/home/user/a','/home/user'),'~/a');assert.equal(api.abbreviateHomePath('/home/username','/home/user'),'/home/username');assert.equal(api.abbreviateHomePath('/root','/'),'/root');assert.equal(api.abbreviateHomePath('C:\\Users\\a','C:\\Users'),'C:\\Users\\a')
  })
  test(`${label}: opaque durable provenance renders newer sources without conflating recalled and injected context`,()=>{
    const api=helpers('sessions/context-provenance',['contextProvenance','sessionRecallLabels','contextForm']);assert.equal(api.contextProvenance(null).label,null);assert.equal(api.contextProvenance({kind:'new-producer',form:'new-form'}).label,'new-producer');assert.equal(api.contextForm({kind:'new-producer',form:'new-form'}),null);assert.equal(api.contextForm({form:'relay'}),'relay');const source={kind:'session-reference',references:[{label:'first'},{label:'first'},{label:'second'},null]};assert.equal(api.contextProvenance(source).role,'recall');assert.equal(api.contextProvenance(source).label,'first, second');assert.deepEqual(Array.from(api.sessionRecallLabels(source)),['first','second']);assert.equal(api.contextProvenance({kind:'agent-instructions',changes:[{path:'AGENTS.md'}]}).label,'AGENTS.md')
  })
  test(`${label}: durable auth failure copy does not expose raw credentials`,()=>{
    const {displayFailureMessage}=helpers('sessions/failure-display',['displayFailureMessage']);assert.equal(displayFailureMessage({code:'AUTH',message:'key secret'}),'API key is invalid');assert.equal(displayFailureMessage({code:'NETWORK',message:'timeout'}),'timeout');assert.equal(displayFailureMessage('text'),'text');assert.equal(displayFailureMessage(null),'null')
  })
  test(`${label}: subagent lineage terminates ordinary forks and fails soft on cycles and missing owners`,()=>{
    const {indexSubagentDescendants}=helpers('sessions/subagent-lineage',['indexSubagentDescendants']);const indexed=indexSubagentDescendants({root:{id:'root',running:false},child:{id:'child',origin:'subagent',parentId:'root',running:true},grand:{id:'grand',origin:'subagent',parentId:'child',running:false},fork:{id:'fork',parentId:'root',running:false},forkChild:{id:'forkChild',origin:'subagent',parentId:'fork',running:true},orphan:{id:'orphan',origin:'subagent',parentId:'absent',running:false}});assert.equal(indexed.get('root').count,2);assert.equal(indexed.get('root').runningCount,1);assert.equal(indexed.get('fork').count,1);assert.equal(indexed.get('absent').count,1);const cycle=indexSubagentDescendants({a:{id:'a',origin:'subagent',parentId:'b',running:false},b:{id:'b',origin:'subagent',parentId:'a',running:true}});assert.equal(cycle.size,2)
  })
}

// Whole connection entry A/B: unlike the early pure-function probes, these
// execute the shipped ModuleLoader plugin and its real carrier/fixture closure.
function connectionGlobals(search = '?fixture') {
  let ids=0
  class FixedDate extends Date {constructor(...args){super(...(args.length?args:[1723500000000]))} static now(){return 1723500000000}}
  return {structuredClone, URLSearchParams, queueMicrotask, setTimeout, clearTimeout, setInterval, clearInterval, Date:FixedDate,
    location:{origin:'https://localhost:8443',hostname:'localhost',search},
    crypto:{randomUUID:()=>`00000000-0000-4000-8000-${(++ids).toString().padStart(12,'0')}`,getRandomValues:array=>{const n=++ids;array.fill(n);return array}},
    console:{warn(){},error(){}},__zod_globalConfig:zod.z.core.config()}
}
function connectionFixture(label, search='?fixture', moreGlobals={}) {
  const globals={...connectionGlobals(search),...moreGlobals};const api=label==='legacy'?legacy('client-connection',globals):sourceModule('client-connection',globals)
  let handle;api.apply({provide(name,value){assert.equal(name,'connection');handle=value}})
  return {api,handle,globals}
}
// Real Cordis contexts contain a cyclic root/fiber graph. Compare their ABI
// scope identity rather than serializing implementation internals (business
// snapshot fields and all foreign JSON fields remain in this projection).
const json=value=>JSON.parse(JSON.stringify(value,(_key,item)=>{
  if(!Core.Context.is(item))return item
  const identity=item.root.get('identity')
  return {cordisContext:true,sessionId:typeof identity==='function'?identity(item):undefined}
}))
function legacyConnectionSchemas(names) {
  let registration;const globals=connectionGlobals('');const code=readFileSync(join(repo,'ui/reference/master-a613970/plugins/@xharness/dsh-client-connection/client.js'),'utf8')
  const hook=`exports.__schemas={${names.join(',')}};return module.exports;`
  const realm=vm.createContext({...globals,__zod_globalConfig:undefined,window:{__ModuleLoader__:{load(value){registration=value}}},Promise,AbortController,AbortSignal,URL,Error})
  // Frozen connection carries the schema-only Zod kernel; the full browser
  // initializes English through another package. Initialize the same pinned
  // SDK in this exact realm before evaluating the immutable frozen factory.
  vm.runInContext(compiledEntry('client-connection','contracts/host/apiproxy/api/rpc.schema'),realm)
  registration.factory(()=>{throw Error('schema SDK unexpectedly requires external')})
  vm.runInContext(code.replace('return module.exports;',hook),realm)
  return rememberSchemaRealm(registration.factory(()=>{throw Error('connection unexpectedly requires external')}).__schemas,realm)
}

test('connection: full fixture entry, inventories, host facts and paged durable history match the production baseline',async()=>{
  const fixtures=['legacy','source'].map(label=>connectionFixture(label))
  const traces=[]
  for(const f of fixtures){
    const trace=[];trace.push(await f.handle.api.host.describe({}));trace.push(await f.handle.api.sessions.list({}));trace.push(await f.handle.api.workspace.list({}));trace.push(await f.handle.api.skills.list({sessionId:'fx-alpha'}));trace.push(await f.handle.api.agentPresets.list({}));trace.push(await f.handle.api.llm.providers({}));trace.push(await f.handle.api.llm.models({}));trace.push(await f.handle.api.credentials.describe({refs:[]}));trace.push(await f.handle.api.settings.describe({}));
    for(const sid of ['fx-alpha','fx-empty','not-present']){trace.push(await f.handle.api.sessions.history({sessionId:sid,limit:20}));trace.push(await f.handle.api.sessions.models({sessionId:sid}));}
    trace.push(await f.handle.api.sessions.search({query:'fixture'}));trace.push(await f.handle.api.subagents.list({parentSessionId:'fx-alpha'}));traces.push(json(trace))
    assert.equal(f.handle.isLoopback,true);assert.equal(f.handle.hostDescription.getSnapshot(),undefined)
    assert.equal(Object.keys(f.api).sort().join(','),'AbstractApiClient,RpcId,apply,inject,transportError')
  }
  assert.deepEqual(traces[1],traces[0])
})

test('connection: complete shipped DTO schemas have identical acceptance, normalization and Zod issues',()=>{
  const files=['rpc','events','sessions','approvals','workspace','host','skills','agent-presets','goals','settings','credentials','llm','subagents','jobs']
  const sourceSchemas={};for(const file of files)Object.assign(sourceSchemas,sourceModule('client-connection',{}, {},`contracts/host/apiproxy/api/${file}.schema`))
  const names=Object.keys(sourceSchemas).filter(name=>name.endsWith('Schema')&&sourceSchemas[name]?.safeParse)
  const legacyCode=readFileSync(join(repo,'ui/reference/master-a613970/plugins/@xharness/dsh-client-connection/client.js'),'utf8')
  const present=names.filter(name=>new RegExp(`\\b${name}\\s*=`).test(legacyCode))
  const oldSchemas=legacyConnectionSchemas(present)
  const corpus=[undefined,null,false,true,'','text',0,1,-1,[],{}, {ok:true,value:null},{ok:false,error:{code:'internal',message:'failed'}},{type:'server-response',rpcId:'id',result:{ok:true,value:{}}}, {type:'server-request',rpcId:'id',method:'events/mux',payload:{type:'stream/error',error:{code:'internal',message:'failed'}}},{sessionId:'sid',seq:0,type:'turn/end',payload:{reason:'done'}},{attachmentId:'a',mediaType:'image/png',bytes:1,width:1,height:1},{id:'w',title:'workspace',sessions:[],cwd:'/tmp'},{nested:[null,'a',3,{done:true}]}, {type:'image_ref',attachmentId:'image-id'}, {type:'file_ref',attachmentId:'file-id',name:'report.txt'}, {type:'file',mediaType:'text/plain',data:'YQ==',name:'a.txt'}, {attachmentId:'file-id',mediaType:'application/pdf',bytes:0,width:null,height:null}, {provider:'p',model:'m',contextWindowTokens:128000}, {id:'m',name:'Model',reasoningCapability:{mode:'supported'},contextWindow:128000,contextWindowSource:'provider',contextWindowCapability:{editable:false}}]
  for(const name of present)for(const candidate of corpus){const a=oldSchemas[name].safeParse(schemaRealmInput(oldSchemas[name],candidate)),b=sourceSchemas[name].safeParse(schemaRealmInput(sourceSchemas[name],candidate));assert.equal(b.success,a.success,`${name} acceptance`);assert.deepEqual(json(b.success?b.data:b.error.issues),json(a.success?a.data:a.error.issues),`${name} result`)}
  assert.ok(present.length>=90,`only ${present.length} complete schemas tested`)
})

for(const label of ['legacy','source']){
  test(`${label}: whole wire root validates correlation, unary results, HTTP errors and envelope observation`,async()=>{
    const f=connectionFixture(label,'');let handler;const requests=[];const batches=[]
    class Carrier extends f.api.AbstractApiClient {doFetch(url,init){requests.push({url:String(url),init});return handler(JSON.parse(init.body))}}
    const client=new Carrier(123);const off=client.subscribeEnvelopes(batch=>batches.push(json(batch)));client.subscribeEnvelopes(()=>{throw Error('sink')})
    handler=async message=>({ok:true,json:async()=>({type:'server-response',rpcId:message.rpcId,result:{ok:true,value:{sessionId:'created'}}})})
    const response=await client.sessions.create({title:'new'});assert.equal(response.result.value.sessionId,'created');await drain();assert.equal(batches.flat().length,2);assert.match(requests[0].url,/\/api\/session.create$/);assert.equal(requests[0].init.signal.aborted,false)
    handler=async()=>({ok:true,json:async()=>({type:'server-response',rpcId:'wrong',result:{ok:true,value:{}}})});await assert.rejects(client.sessions.list({}),/rpcId mismatch/)
    handler=async message=>({ok:true,json:async()=>({type:'server-response',rpcId:message.rpcId,result:{ok:true,value:'not-a-session-list'}})});await assert.rejects(client.sessions.list({}),/Invalid input/)
    handler=async message=>({ok:true,json:async()=>({type:'server-response',rpcId:message.rpcId,result:{ok:false,error:{code:'internal',message:'fixture',details:{}}}})});assert.equal((await client.sessions.list({})).result.ok,false)
    handler=async()=>({ok:false,status:502});await assert.rejects(client.sessions.list({}),/HTTP 502/);off()
  })
  test(`${label}: generic RPC routes, same-origin base, cancellation and response envelopes remain strict`,async()=>{
    let handler;const requests=[];const f=connectionFixture(label,'',{fetch:async(url,init)=>{requests.push({url:String(url),init});return handler(JSON.parse(init.body))}})
    const abort=new AbortController();abort.abort();handler=async message=>({ok:true,json:async()=>({type:'server-response',rpcId:message.rpcId,result:{ok:true,value:{echo:message.payload}}})})
    assert.deepEqual(json(await f.handle.rpc.call('/rpc','demo/echo',{value:'x'},abort.signal)),{ok:true,value:{echo:{value:'x'}}});assert.equal(requests[0].init.signal,abort.signal);assert.equal(requests[0].url,'https://localhost:8443/rpc/demo/echo')
    for(const [channel,endpoint]of [['api','echo'],['/rpc','../escape'],['/rpc','a//b'],['/rpc','a?query'],['/rpc','']])await assert.rejects(f.handle.rpc.call(channel,endpoint,{}),/invalid RPC target/)
    handler=async()=>({ok:true,json:async()=>({type:'server-response',rpcId:'other',result:{ok:true,value:null}})});await assert.rejects(f.handle.rpc.call('/api','demo/echo',{}),/rpcId mismatch/)
    handler=async()=>({ok:false,status:403});await assert.rejects(f.handle.rpc.call('/api','demo/echo',{}),/HTTP 403/)
  })
  test(`${label}: production WebSocket carrier parses frames, drops malformed input and closes owned listeners`,async()=>{
    const sockets=[];class Socket{static CONNECTING=0;static OPEN=1;readyState=0;listeners=new Map();constructor(url){this.url=String(url);sockets.push(this)}addEventListener(event,fn){if(!this.listeners.has(event))this.listeners.set(event,new Set());this.listeners.get(event).add(fn)}removeEventListener(event,fn){this.listeners.get(event)?.delete(fn)}emit(event,value){for(const fn of this.listeners.get(event)??[])fn(value)}close(){this.readyState=3;this.emit('close')}}
    const f=connectionFixture(label,'',{WebSocket:Socket});const abort=new AbortController();let opened=0;const stream=f.handle.api.events.mux({},abort.signal,()=>opened++);const iterator=stream[Symbol.asyncIterator]();const first=iterator.next();assert.equal(sockets.length,1);assert.equal(sockets[0].url,'wss://localhost:8443/api/events.mux');sockets[0].readyState=1;sockets[0].emit('open');assert.equal(opened,1)
    sockets[0].emit('message',{data:'not-json'});sockets[0].emit('message',{data:new Uint8Array()});sockets[0].emit('message',{data:JSON.stringify({type:'server-request',rpcId:'frame',method:'events/mux',payload:{type:'stream/error',error:{code:'internal',message:'gone',details:{}}}})});const next=await first;assert.equal(next.done,false);assert.equal(next.value.rpcId,'frame');assert.equal(next.value.payload.type,'stream/error');abort.abort();assert.equal((await iterator.next()).done,true);assert.equal([...sockets[0].listeners.values()].every(set=>set.size===0),true)
  })
}

test('connection: fixture mutations, edit-before-user forks and generic Remote fake-server traffic match',async()=>{
  const traces=[]
  for(const label of ['legacy','source']){
    const f=connectionFixture(label);const trace=[];const api=f.handle.api
    const page=await api.sessions.history({sessionId:'fx-alpha',maxMessages:1000});const user=page.result.value.events.find(entry=>entry.event.type==='user/message'&&entry.event.data.source.kind==='user')
    assert.ok(user);trace.push(await api.sessions.fork({sessionId:'fx-alpha',beforeUserSeq:user.event.seq}));trace.push(await api.sessions.fork({sessionId:'fx-alpha',beforeUserSeq:999999}));trace.push(await api.sessions.list({}));trace.push(await api.workspace.list({}))
    const workspace=await api.workspace.create({path:'/tmp/ab-workspace'});trace.push(workspace);trace.push(await api.workspace.rename({workspaceId:workspace.result.value.workspace.workspaceId,title:'A/B'}));trace.push(await api.workspace.delete({workspaceId:workspace.result.value.workspace.workspaceId}))
    const created=await api.sessions.create({cwd:'/tmp/source-ab'});trace.push(created);trace.push(await api.sessions.rename({sessionId:created.result.value.sessionId,title:'new title'}));trace.push(await api.sessions.history({sessionId:created.result.value.sessionId}));trace.push(await f.handle.rpc.call('/api','commands/list',{args:{agentId:'fx-alpha'}}));await assert.rejects(f.handle.rpc.call('/rpc','unknown/test',{args:{}}),/unavailable/);traces.push(json(trace))
  }
  assert.deepEqual(traces[1],traces[0])
})

test('connection: production compiler packages the whole entry and Zod without an external loader escape',async()=>{
  const id='@xharness/dsh-client-connection';const row={id,source:'src/modules/client-connection/index.ts'};const built=compileSourceModules(join(repo,'ui'),[row]).get(id)
  assert.deepEqual(built.external,[]);assert.ok(built.sources.includes('npm:zod@4.4.3'));assert.ok(built.sources.includes('src/modules/client-connection/fixture.ts'))
  let registration;const globals=connectionGlobals('?fixture');vm.runInNewContext(built.bytes.toString(),{...globals,window:{__ModuleLoader__:{load(value){registration=value}}},Promise,AbortController,AbortSignal,URL,Error})
  assert.equal(registration.id,id);const api=registration.factory(request=>{throw Error(`Unexpected production loader request ${request}`)});let connection;api.apply({provide(_name,value){connection=value}});assert.equal((await connection.api.host.describe({})).result.ok,true)
})

function runtimeFixture(label, globals={}, suppliedApi) {
  const ctx=new Core.Context(),trace=[];const inherited={...connectionGlobals(''),Map,Set,queueMicrotask,process:{env:{NODE_ENV:'production'}},...globals}
  const core=sourceModule('platform',inherited,{},'slots/index')
  const externals={'@xharness/cordis':Core,'@xharness/dsh-client-ui-slots':core}
  const api=suppliedApi?suppliedApi(externals):(label==='legacy'?legacy('client-runtime',inherited,externals):sourceModule('client-runtime',inherited,externals))
  ctx.provide('remote',{commands:{execute:async()=>({ok:true,value:undefined})},$dispatch:(event,args)=>trace.push(['dispatch',event,args])})
  ctx.provide('typert',{contexts:{registerClient(_name,provider){return ctx.provide('identity',provider.identity)}}})
  const services={get:name=>ctx.get(name),set(name,value){if(ctx.get(name)===undefined)ctx.provide(name,value);else ctx.set(name,value)}}
  return {api,ctx,services,trace,externals,globals:inherited,dispose(){return ctx.fiber.dispose()}}
}
for(const label of ['legacy','source']){
  test(`${label}: complete runtime stores retain structural sharing, no-op suppression, batching, persistence and scoped action identities`,async()=>{
    const storage=new Map();const f=runtimeFixture(label,{localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)}});const api=f.api
    const leaf={stable:true};const store=api.createSnapshotStore({leaf,count:0,rows:[]});const initial=store.getSnapshot();let notifications=0;const off=store.subscribe(()=>notifications++)
    store.update(()=>{});assert.equal(store.getSnapshot(),initial);assert.equal(notifications,0);store.update(draft=>{draft.count++;draft.rows.push('a')});const updated=store.getSnapshot();assert.equal(updated.leaf,initial.leaf);assert.notEqual(updated,initial);assert.equal(Object.isFrozen(updated),true);assert.equal(notifications,1);store.set(updated);assert.equal(notifications,1);const replacement={leaf:{stable:false},count:9,rows:[]};store.set(replacement);assert.equal(store.getSnapshot(),replacement);assert.equal(Object.isFrozen(replacement),false);off()
    const frames=api.createSnapshotStore(0,{flush:'raf'});let flushes=0;frames.subscribe(()=>flushes++);frames.set(1);frames.set(2);assert.equal(frames.getSnapshot(),2);assert.equal(flushes,0);await drain();assert.equal(flushes,1)
    storage.set('counter.s1','{"count":4}');const handle=api.defineStore({init:()=>({count:0}),persist:'counter',actions:{add:(draft,n)=>{draft.count+=n}}});const a=handle.create('s1'),b=handle.create('s2');assert.equal(a.getSnapshot().count,4);const action=a.actions.add;action(3);assert.equal(a.actions.add,action);assert.equal(a.getSnapshot().count,7);assert.equal(b.getSnapshot().count,0);assert.equal(storage.get('counter.s1'),'{"count":7}');a.clearPersisted();assert.equal(storage.has('counter.s1'),false)
    for(const[left,right,expected]of [[new Map([['a',1]]),new Map([['a',1]]),true],[new Map([['a',1]]),new Map([['a',2]]),false],[new Set([1,2]),new Set([2,1]),true],[new Set([1]),new Set([2]),false],[{a:1},{a:1},true],[{a:1},{a:2},false],[NaN,NaN,true],[0,-0,false]])assert.equal(api.shallowEqual(left,right),expected)
    await f.dispose()
  })
  test(`${label}: complete SlotRegistry preserves declaration effects, shared store axes, scope prune and unload cascade`,async()=>{
    const f=runtimeFixture(label);await f.ctx.plugin(f.api.SlotRegistry);const slots=f.services.get('slots');const log=[];const injected=slots.inject('probe',function*(){log.push('mount');yield()=>log.push('first');yield()=>log.push('second')});assert.deepEqual(log,[])
    const sharedInject={fromDeclaration:'retained'},rootOff=slots.register({name:'root',children:{probe:{kind:'list',scope:'session',inject:sharedInject}}},()=>null);assert.deepEqual(log,['mount']);assert.equal(slots.spec('probe').inject,sharedInject,'declaration-level inject is an object, never an entry callback');const store=f.api.defineStore({init:()=>({count:0}),actions:{add:draft=>{draft.count++}}});let language='en';const slotLabel=()=>language==='en'?'Probe':'探针';const offA=slots.register({name:'probe',id:'a',store,label:slotLabel},()=>null),offB=slots.register({name:'probe',id:'b',store},()=>null);assert.equal(slots.entries('probe')[0].options.label,slotLabel,'locale thunk identity survives registration');assert.equal(slotLabel(),'Probe');language='zh';assert.equal(slots.entries('probe')[0].options.label(),'探针','labels follow locale without re-registration');f.services.set('sessions',{list:snapshot({}),currentProvideInfo:snapshot({})});f.services.set('workspaces',{list:snapshot({})});let host;slots.install({renderRoot(value){host=value;return null}});slots.renderSlot('root',{});const [a,b]=slots.entries('probe');const first=host.storeOf(a,'s1');assert.equal(first,host.storeOf(b,'s1'));assert.notEqual(first,host.storeOf(a,'s2'));first.actions.add();assert.equal(host.storeOf(b,'s1').getSnapshot().count,1);slots.pruneStoreScope('s1');assert.notEqual(first,host.storeOf(a,'s1'));assert.equal(host.storeOf(a,'s1').getSnapshot().count,0)
    await offA();await offB();await rootOff();await drain();assert.deepEqual(log,['mount','second','first']);assert.equal(slots.entries('probe').length,0);await injected();await f.dispose()
  })
  test(`${label}: whole runtime apply mounts services, re-baselines sessions/workspaces, forwards Remote events and owns loop disposal`,async()=>{
    const f=runtimeFixture(label);const connection=connectionFixture(label);let sinks;let stopped=0;f.services.set('connection',{api:connection.handle.api,start(value){sinks=value;return{stop(){stopped++}}}});f.api.apply(f.ctx);await drain();const sessions=f.services.get('sessions'),workspaces=f.services.get('workspaces');assert.ok(sessions&&workspaces&&f.services.get('slots'));assert.equal(sessions.list.getSnapshot().phase,'pending');sinks.onConnected();await drain();assert.equal(sessions.list.getSnapshot().phase,'ready');assert.equal(workspaces.list.getSnapshot().phase,'ready');assert.ok(sessions.list.getSnapshot().ids.includes('fx-alpha'));const alpha=sessions.binding('fx-alpha');assert.ok(alpha);assert.equal(f.ctx.identity(alpha.ctx),'fx-alpha');assert.equal(f.ctx.identity(f.ctx),undefined)
    sessions.open('fx-alpha');await drain();assert.equal(sessions.list.getSnapshot().current,'fx-alpha');assert.equal(sessions.sessionOf(alpha.ctx).sessionId,'fx-alpha');assert.equal(alpha.session.getSnapshot().openState,'open')
    sinks.onHostEnvelope({rpcId:'host-event',payload:{type:'host/remote-event',event:'fixture/push',args:[1,'two']}});assert.deepEqual(f.trace.find(row=>row[0]==='dispatch'),['dispatch','fixture/push',[1,'two']]);sinks.onStateChange('reconnecting');sinks.onConnected();await drain();assert.equal(sessions.list.getSnapshot().phase,'ready');await f.dispose();assert.equal(stopped,1)
  })
}

test('runtime: Session/Workspace source projections and production epoch recency match frozen behavior',async()=>{
  const traces=[]
  for(const label of ['legacy','source']){
    const f=runtimeFixture(label);const api=connectionFixture(label).handle.api;let sinks;f.services.set('connection',{api,start(value){sinks=value;return{stop(){}}}});f.api.apply(f.ctx);sinks.onConnected();await drain();const sessions=f.services.get('sessions'),workspaces=f.services.get('workspaces');sessions.clear();await drain();
    // Host-created empty workspaces carry decimal-string timestamps, not ISO.
    sinks.onHostEnvelope({rpcId:'w1',payload:{type:'host/workspace-changed',workspace:{workspaceId:'epoch-old',path:'/tmp/old',title:'old',sessionIds:[],createdAt:'1700000000000',updatedAt:'1700000000000'}}});sinks.onHostEnvelope({rpcId:'w2',payload:{type:'host/workspace-changed',workspace:{workspaceId:'epoch-new',path:'/tmp/new',title:'new',sessionIds:[],createdAt:'1800000000000',updatedAt:'1800000000000'}}});await drain();assert.equal(workspaces.list.getSnapshot().recentWorkspaceId,'epoch-new')
    const created=await sessions.create({cwd:'/tmp/new-session'});sessions.open(created);await drain();const binding=sessions.binding(created);const trace=[json(sessions.list.getSnapshot()),json(workspaces.list.getSnapshot()),json(binding.session.getSnapshot())];trace.push(await binding.session.command('/not-matched'));trace.push(await binding.session.rename('  New title  '));await drain();trace.push(json(binding.session.getSnapshot()));await f.dispose();traces.push(json(trace))
  }
  assert.deepEqual(traces[1],traces[0])
})

function runtimeInternals(names, globals={}) {
  let registration;const f=runtimeFixture('source');const code=readFileSync(join(repo,'ui/reference/master-a613970/plugins/@xharness/dsh-client-runtime/client.js'),'utf8')
  vm.runInNewContext(code.replace('return module.exports;',`exports.__internals={${names.join(',')}};return module.exports;`),{...f.globals,...globals,window:{__ModuleLoader__:{load(value){registration=value}}},Promise,AbortController,AbortSignal,URL,Error})
  return registration.factory(spec=>f.externals[spec]).__internals
}

test('runtime: strict vanilla adapter retains state/previous notifications, live subscription iteration and function replacements',()=>{
  const old=runtimeInternals(['createStoreImpl']);const source=sourceModule('client-runtime',{Map,Set},{},'contract/state-engine');const traces=[]
  for(const create of [initial=>old.createStoreImpl(()=>initial),source.createStateEngine]){
    const initial={count:0};const api=create(initial);const trace=[];let offB;let added=false
    api.subscribe((state,previous)=>{trace.push(['a',state.count,previous.count]);if(!added){added=true;offB();api.subscribe((s,p)=>trace.push(['c',s.count,p.count]))}})
    offB=api.subscribe((state,previous)=>trace.push(['b',state.count,previous.count]));api.setState(initial,true);api.setState({count:1},true);api.setState(state=>({count:state.count+1}),true);assert.equal(api.getState().count,2);traces.push(trace)
  }
  assert.deepEqual(traces[1],traces[0]);assert.deepEqual(traces[1],[['a',1,0],['c',1,0],['a',2,1],['c',2,1]])
})

test('runtime: prompt edit admission, pending responses, queues and projection generation watermarks match frozen Session behavior',async()=>{
  const traces=[]
  for(const label of ['legacy','source']){
    const f=runtimeFixture(label,{Intl,atob});const api=connectionFixture(label).handle.api;const calls=[]
    api.sessions.prompt=async(payload,signal)=>{calls.push(['prompt',json(payload),signal?.aborted??false]);return{rpcId:'reply',result:{ok:true,value:{accepted:true}}}}
    api.respond=async payload=>{calls.push(['respond',json(payload)]);return{accepted:true}}
    let sinks;f.services.set('connection',{api,start(value){sinks=value;return{stop(){}}}});f.api.apply(f.ctx);sinks.onConnected();await drain();const sessions=f.services.get('sessions');const sid=await sessions.create({cwd:'/tmp/prompt-test'});sessions.open(sid);await drain();const session=sessions.binding(sid).session;const trace=[]
    const abort=new AbortController();abort.abort();await session.prompt([{type:'text',text:'edited'}],'queue',abort.signal,{requireIdle:true});await session.prompt([{type:'file_ref',attachmentId:'doc',name:'readme.md'}],'steer',undefined,{requireIdle:false});trace.push(json(session.getSnapshot()))
    sinks.onMuxEnvelope({rpcId:'approval-id',payload:{type:'approval/requested',sessionId:sid,approvalId:'approval',toolName:'edit'}});sinks.onMuxEnvelope({rpcId:'question-id',payload:{type:'question/requested',sessionId:sid,questions:[]}});await drain();const pending=session.getSnapshot().pending;assert.equal(pending.length,2);await pending[0].respond({ok:true,value:{approved:true}});trace.push(json(session.getSnapshot()));sinks.onMuxEnvelope({rpcId:'resolved',payload:{type:'approval/resolved',sessionId:sid,approvalId:'approval',outcome:'approved'}});assert.throws(()=>pending[0].respond({ok:true,value:{}}),/already settled/)
    sinks.onMuxEnvelope({rpcId:'queue',payload:{type:'session/queue',sessionId:sid,items:[{id:'q1',placement:'queued',message:{id:'m1',role:'user',source:{kind:'user'},content:[{type:'text',text:' hello  world '}] }},{id:'q2',placement:'steering',message:{id:'m2',role:'user',source:{kind:'user'},content:[{type:'text',text:' 😀 '.repeat(220)}]}}]}});trace.push(json(session.getSnapshot()));sinks.onMuxEnvelope({rpcId:'projection',payload:{type:'session/projection',sessionId:sid,key:'title',value:{title:'newer'},seq:4}});sinks.onMuxEnvelope({rpcId:'projection-old',payload:{type:'session/projection',sessionId:sid,key:'title',value:{title:'stale'},seq:3}});assert.equal(session.projections.get('title').title,'newer');const face=session.projections.faceOf('title');assert.equal(face,session.projections.faceOf('title'));session.projections.seed({asOfSeq:2,values:{}});assert.equal(face.getSnapshot().title,'newer');session.projections.seed({asOfSeq:4,values:{}});assert.equal(face.getSnapshot(),undefined)
    sinks.onStateChange('reconnecting');trace.push(json(session.getSnapshot()));sinks.onConnected();sinks.onMuxEnvelope({rpcId:'subscribed',payload:{type:'session/subscribed',sessionId:sid,lastSeq:0}});await drain();assert.equal(session.getSnapshot().queue.length,0);assert.equal(session.getSnapshot().pending.length,0);trace.push(json(session.getSnapshot()));trace.push(calls);traces.push(json(trace));await f.dispose()
  }
  assert.deepEqual(traces[1],traces[0]);assert.equal(traces[1].at(-1)[0][1].requireIdle,true);assert.equal('requireIdle' in traces[1].at(-1)[1][1],false)
})

const logEvent=(seq,type,data)=>({seq,type,data,timestamp:1723500000000})
const eventInput=event=>({event,view:undefined})
test('runtime: Conversation registries and incremental assembler retain prepend dependencies, location boundaries and view identities',async()=>{
  const traces=[]
  for(const label of ['legacy','source']){
    const f=runtimeFixture(label);const events=new f.api.ConversationEventRegistry(f.ctx),views=new f.api.ConversationViewRegistry(f.ctx);const nodes=new Map();const published=[]
    const offView=views.register({target:'probe',create:()=>({empty:[],replace(input){nodes.clear();for(const node of input.nodes)nodes.set(node.key,node);published.push(['replace',input.nodes.length,[...input.timeline.turnOrder]]);return[...nodes.values()]},apply(input){for(const node of input.upserts)nodes.set(node.key,node);published.push(['apply',input.upserts.length,[...input.timeline.turnOrder]]);return[...nodes.values()]}})})
    const definition={kind:'text',target:'probe',match:event=>event.type==='user/message'?{id:event.data.id,role:'start'}:null,start(context,match,reader){return{text:match.event.data.content[0].text,previous:reader.previous('text')?.state.text??null}},update:context=>context.state,buildViewNode(context){return{key:context.key,kind:context.kind,id:context.id,target:'probe',data:context.state}}}
    const off=events.register(definition);assert.throws(()=>events.register(definition),/already registered/);assert.throws(()=>events.register({kind:'bad',target:'probe',match:()=>null,start:()=>null,update:()=>null}),/target and buildViewNode/)
    const assembler=new f.api.ConversationNodeAssembler(events,views);const user=(seq,id,text)=>({...logEvent(seq,'user/message',{id,role:'user',content:[{type:'text',text}],source:{kind:'user'}}),surfaceOp:'append'})
    assembler.replaceWindow([eventInput(user(4,'b','second')),eventInput(logEvent(3,'step/start',{turn:1,step:1}))],true);assembler.flush();const first=assembler.snapshot('probe');assert.equal(first[0].data.previous,null);assembler.prepend([eventInput(logEvent(0,'turn/start',{turn:1})),eventInput(user(1,'a','first')),eventInput(logEvent(2,'step/start',{turn:1,step:0}))],false);assembler.flush();const after=assembler.snapshot('probe');assert.equal(after.find(node=>node.id==='b').data.previous,'first');assert.equal(assembler.append(eventInput(user(4,'b','duplicate'))),'none');assembler.append(eventInput(logEvent(5,'step/end',{turn:1,step:1})));assembler.append(eventInput(logEvent(6,'turn/end',{turn:1,reason:'completed'})));assembler.flush();traceTimeline(assembler)
    function traceTimeline(value){const locations=new f.api.ConversationLocationIndex();locations.rebuild([0,1,2,3,4,5,6].map(seq=>({event:seq===0?logEvent(seq,'turn/start',{turn:1}):seq===2||seq===3?logEvent(seq,'step/start',{turn:1,step:seq-2}):seq===5?logEvent(seq,'step/end',{turn:1,step:1}):seq===6?logEvent(seq,'turn/end',{turn:1,reason:'completed'}):user(seq,String(seq),'value'),view:undefined})));const timeline=locations.snapshot();traces.push(json({nodes:value.snapshot('probe'),published,turns:[...timeline.turns].map(([id,turn])=>({id,status:turn.status,steps:turn.steps.map(step=>({step:step.step,status:step.status}))}))}))}
    await off();assert.equal(events.entries().length,0);assembler.rebuildRegistry();assembler.flush();assert.equal(assembler.snapshot('probe').length,0);await offView();await f.dispose()
  }
  assert.deepEqual(traces[1],traces[0])
})

test('runtime: production compiler bundles genuine pinned Immer and bootstraps without a process/global package escape',async()=>{
  const id='@xharness/dsh-client-runtime';const built=compileSourceModules(join(repo,'ui'),[{id,source:'src/modules/client-runtime/index.ts'}]).get(id)
  assert.deepEqual(built.external,['@xharness/cordis','@xharness/dsh-client-ui-slots']);assert.ok(built.sources.includes('vendor:immer@10.2.0'));assert.ok(built.sources.includes('src/modules/client-runtime/sessions/session.ts'));assert.ok(!built.sources.some(path=>path.includes('Documents/Codex')))
  const globals=connectionGlobals('');let registration;vm.runInNewContext(built.bytes.toString(),{...globals,window:{__ModuleLoader__:{load(value){registration=value}}},Promise,AbortController,AbortSignal,URL,Error})
  const f=runtimeFixture('source',{},externals=>registration.factory(spec=>{assert.ok(spec in externals,`production external ${spec}`);return externals[spec]}));const fixture=connectionFixture('source');let sinks;f.services.set('connection',{api:fixture.handle.api,start(value){sinks=value;return{stop(){}}}});f.api.apply(f.ctx);sinks.onConnected();await drain();assert.equal(f.services.get('sessions').list.getSnapshot().phase,'ready')
  // Readiness of the two baseline RPCs precedes the runtime-owned initial
  // selection/create and scoped history work. Await that actual completion,
  // rather than tearing down its Core owner after an arbitrary microtask count.
  const sessions=f.services.get('sessions');let current
  for(let attempt=0;attempt<100;attempt++){
    current=sessions.list.getSnapshot().current
    if(current!==undefined)break
    await new Promise(resolve=>setImmediate(resolve))
  }
  assert.notEqual(current,undefined,'real initial selection completed')
  const binding=sessions.binding(current);assert.ok(binding)
  await binding.ctx.fiber.await();await binding.session.open();await drain()
  assert.equal(binding.session.getSnapshot().openState,'open')
  const store=f.api.createSnapshotStore({count:0});store.update(draft=>draft.count++);assert.equal(store.getSnapshot().count,1);assert.equal(Object.isFrozen(store.getSnapshot()),true);await f.dispose()
})

function runtimeObjectLayer(label,globals={}) {
  if(label==='legacy')return runtimeInternals(['Session','SessionManager'],globals)
  const f=runtimeFixture('source',globals)
  return {...sourceModule('client-runtime',f.globals,f.externals,'sessions/session'),...sourceModule('client-runtime',f.globals,f.externals,'sessions/manager')}
}

for(const label of ['legacy','source']){
  test(`${label}: native before-user fork forwards floored boundaries, keeps edit children blank and reconciles published failures`,async()=>{
    const f=runtimeFixture(label);const api=connectionFixture(label).handle.api;const wireFork=api.sessions.fork.bind(api.sessions);const requests=[];let responseOverride
    api.sessions.fork=async payload=>{requests.push(json(payload));return responseOverride?responseOverride(payload):wireFork(payload)}
    let sinks;f.services.set('connection',{api,start(value){sinks=value;return{stop(){}}}});f.api.apply(f.ctx);sinks.onConnected();await drain()
    const sessions=f.services.get('sessions');const sourceId='fx-alpha';const source=sessions.list.getSnapshot().byId[sourceId];assert.ok(source.cwd)
    const sourcePage=(await api.sessions.history({sessionId:sourceId,maxMessages:1000})).result.value.events
    const users=sourcePage.filter(entry=>entry.event.type==='user/message'&&entry.event.data.source.kind==='user');assert.ok(users.length>=2)
    for(const user of [users[0],users[1]]){
      // The public SessionRuntime path must floor both options and preserve the
      // edit cut's precedence over a later ordinary-turn anchor on the wire.
      const beforeUserSeq=user.event.seq,atSeq=sourcePage.at(-1).event.seq
      const childId=await sessions.fork({sessionId:sourceId,beforeUserSeq:beforeUserSeq+0.75,atSeq:atSeq+0.25})
      assert.deepEqual(requests.at(-1),{sessionId:sourceId,atSeq,beforeUserSeq})
      const child=sessions.list.getSnapshot().byId[childId]
      assert.equal(child.blank,true);assert.equal(child.origin,'fork');assert.equal(child.parentId,sourceId);assert.equal(child.cwd,source.cwd);assert.equal(child.running,false)
      assert.ok(sessions.binding(childId),'fork resolution makes its real scope immediately addressable')
      const userIndex=sourcePage.indexOf(user),priorEnd=sourcePage.slice(0,userIndex).findLastIndex(entry=>entry.event.type==='turn/end')
      const history=(await api.sessions.history({sessionId:childId,maxMessages:1000})).result.value.events
      assert.deepEqual(json(history),json(sourcePage.slice(0,priorEnd+1)))
      assert.equal(history.some(entry=>entry.event.seq>=beforeUserSeq),false)
      if(user===users[0])assert.equal(history.some(entry=>entry.event.type==='user/message'),false)
      else assert.ok(history.some(entry=>entry.event.type==='user/message'),'later edit retains earlier completed turns')
    }
    const ordinary=await sessions.fork({sessionId:sourceId,atSeq:users[0].event.seq+0.5})
    assert.deepEqual(requests.at(-1),{sessionId:sourceId,atSeq:users[0].event.seq});assert.equal('beforeUserSeq' in requests.at(-1),false)
    assert.equal(sessions.list.getSnapshot().byId[ordinary].blank,false);assert.equal(sessions.list.getSnapshot().byId[ordinary].origin,'fork')
    const beforeIds=Array.from(sessions.list.getSnapshot().ids)
    await assert.rejects(sessions.fork({sessionId:sourceId,atSeq:users[0].event.seq,beforeUserSeq:999999.5}),error=>error.name==='SessionForkError'&&error.sourceSessionId===sourceId&&error.rpcError.code==='fork-unavailable')
    await drain();assert.deepEqual(Array.from(sessions.list.getSnapshot().ids),beforeIds)
    for(const beforeUserSeq of [undefined,users[0].event.seq]){
      const childId=beforeUserSeq===undefined?'published-ordinary':'published-edit'
      responseOverride=async()=>({result:{ok:false,error:{code:'workspace-attach-failed',message:'attachment failed after publication',details:{sessionId:childId,workspaceId:'workspace'}}}})
      await assert.rejects(sessions.fork({sessionId:sourceId,...beforeUserSeq===undefined?{}:{beforeUserSeq}}),error=>error.name==='SessionForkError'&&error.rpcError.details.sessionId===childId)
      await drain();const child=sessions.list.getSnapshot().byId[childId]
      assert.equal(child.blank,beforeUserSeq!==undefined);assert.equal(child.origin,'fork');assert.equal(child.parentId,sourceId);assert.equal(child.cwd,source.cwd);assert.ok(sessions.binding(childId))
    }
    responseOverride=async()=>{throw Error('wire offline')};const beforeTransportIds=Array.from(sessions.list.getSnapshot().ids)
    await assert.rejects(sessions.fork({sessionId:sourceId,beforeUserSeq:users[0].event.seq}),error=>error.name==='SessionForkError'&&error.rpcError.code==='internal'&&error.rpcError.message==='wire offline')
    await drain();assert.deepEqual(Array.from(sessions.list.getSnapshot().ids),beforeTransportIds)
    await f.dispose()
  })
  test(`${label}: native continuable subagent guards all upload/reference attachment kinds without silently dropping them`,async()=>{
    const {Session}=runtimeObjectLayer(label,{Intl});const calls=[]
    const api={sessions:{prompt:async payload=>{calls.push(['ordinary',json(payload)]);return{result:{ok:true,value:{accepted:true}}}}},subagents:{prompt:async payload=>{calls.push(['subagent',json(payload)]);return{result:{ok:true,value:{accepted:true}}}}}}
    const address={parentSessionId:'parent',childSessionId:'child',mode:'continuable'}
    const attachments=[{type:'image',mediaType:'image/png',data:'YQ=='},{type:'image_ref',attachmentId:'image-id'},{type:'file',mediaType:'text/plain',data:'YQ==',name:'notes.txt'},{type:'file_ref',attachmentId:'file-id',name:'notes.txt'}]
    for(const part of attachments)for(const mode of ['queue','steer'])for(const withText of [false,true]){
      const session=new Session('child',api,{}, {address,parentAvailable:true});const content=withText?[{type:'text',text:'keep attachment'},part]:[part]
      const result=await session.prompt(content,mode,undefined,{requireIdle:true})
      assert.deepEqual(json(result),{ok:false,error:{code:'attachment-error',message:'Image input is unavailable for subagent continuations.',details:{reason:'SUBAGENT_IMAGE_UNSUPPORTED'}}})
      assert.equal(calls.length,0,'a guarded attachment must not send a lossy text-only continuation')
      assert.equal(session.getSnapshot().blank,true);assert.deepEqual(json(session.getSnapshot().promptError),json({op:'send',error:result.error}))
    }
    const abort=new AbortController();const text=[{type:'text',text:'valid continuation'}];const child=new Session('child',api,{}, {address,parentAvailable:true})
    assert.equal((await child.prompt(text,'queue',abort.signal,{requireIdle:true})).ok,true)
    assert.equal(calls.length,1);assert.deepEqual(calls[0],['subagent',{...address,content:text,clientTimeZone:Intl.DateTimeFormat().resolvedOptions().timeZone}]);assert.equal('requireIdle' in calls[0][1],false)
    const readOnly=new Session('child',api,{}, {address:{...address,mode:'one-shot'}})
    assert.equal((await readOnly.prompt([attachments[3]],'queue')).error.code,'subagent-not-resumable');assert.equal(calls.length,1)
    const ordinary=new Session('ordinary',api,{})
    assert.equal((await ordinary.prompt(attachments,'steer',undefined,{requireIdle:true})).ok,true)
    assert.equal(calls.length,2);assert.equal(calls[1][0],'ordinary');assert.deepEqual(calls[1][1].content,attachments);assert.equal(calls[1][1].requireIdle,true)
  })
}
const projectedRow=(seq,id=String(seq),role='start',fail=false)=>({event:{seq,time:seq,type:'probe',data:{id,role,fail}}})
const historyReply=(events,hasMore=false)=>({result:{ok:true,value:{events,hasMore}}})
function probeConversation(failView=()=>false) {
  const definition={kind:'probe',target:'probe',match:event=>event.type==='probe'?{id:event.data.id,role:event.data.role}:null,start:()=>({}),update:(context,match)=>{if(match.event.data.fail)throw Error('reducer failure');return context.state},buildViewNode:context=>({key:context.key,target:'probe',seq:context.startSeq})}
  return{events:{entries:()=>[definition],fallbackEntry:()=>undefined},views:{entries:()=>[{target:'probe',create:()=>({empty:[],replace:input=>{if(failView())throw Error('view failure');return input.nodes},apply:input=>input.upserts})}]}}
}

for(const label of ['legacy','source']){
  test(`${label}: frozen history transactions keep committed mappings on faults, preserve interactions and serialize pagination/gap repair`,async()=>{
    const {Session}=runtimeObjectLayer(label);let failBuild=false;const conversation=probeConversation(()=>failBuild);let replies=[],historyCalls=0;const api={sessions:{history:async()=>{historyCalls++;const reply=replies.shift();return typeof reply==='function'?reply():reply}}};const session=new Session('atomic',api,{}, {conversation});const bad=[projectedRow(20,'bad','update'),projectedRow(21,'bad','start')]
    session.installWindow([projectedRow(10)],true);session.openState='open';session.getSnapshot();const committed=session.events,assembler=session.conversation,oldInputs=assembler.inputs,oldSnapshot=assembler.snapshot('probe'),oldLocation=assembler.locationIndex
    assert.throws(()=>assembler.replaceWindow(bad,false),/before its start/);assert.equal(assembler.inputs,oldInputs);assert.equal(assembler.snapshot('probe'),oldSnapshot);assert.equal(assembler.locationIndex,oldLocation);assert.equal(assembler.hasMore,true);assert.throws(()=>assembler.replaceWindow([projectedRow(20,'bad'),projectedRow(21,'bad','update',true)],false),/reducer failure/);failBuild=true;assert.throws(()=>assembler.replaceWindow([projectedRow(30)],false),/view failure/);assert.equal(assembler.snapshot('probe'),oldSnapshot);failBuild=false;assert.throws(()=>assembler.prepend([projectedRow(8,'10','update')],false),/before its start/)
    assert.throws(()=>session.installWindow(bad,false),/before its start/);assert.equal(session.events,committed);assert.equal(session.conversation,assembler);session.liveBuffer=[projectedRow(12),projectedRow(11),projectedRow(12)];session.installWindow([projectedRow(10)],true);assert.deepEqual(Array.from(session.events,event=>event.seq),[10,11,12]);const afterGood=session.events;assert.throws(()=>session.installWindow([projectedRow(10)],true),/backwards/);assert.equal(session.events,afterGood);session.liveBuffer=[projectedRow(15)];assert.throws(()=>session.installWindow([projectedRow(10)],true),/gap/i);assert.equal(session.liveBuffer.length,1);session.liveBuffer=[]
    replies=[historyReply([projectedRow(8,'10','update'),projectedRow(9)])];await session.loadOlder();assert.equal(session.events,afterGood);assert.equal(session.openState,'error');const wait={kind:'approval',id:'keep'};session.pending.set('keep',wait);session.pendingRev++;const rev=session.pendingRev;session.subscribedLastSeq=13;session.acceptLiveEvent(projectedRow(13).event);replies=[historyReply([projectedRow(10),projectedRow(11),projectedRow(12)])];await session.loadOlder();assert.equal(session.openState,'open');assert.equal(session.pending.get('keep'),wait);assert.equal(session.pendingRev,rev);assert.equal(session.subscribedLastSeq,13);assert.deepEqual(Array.from(session.events,event=>event.seq),[10,11,12,13])
    const beforeResync=session.events,beforeSnapshot=assembler.snapshot('probe');replies=[historyReply(bad)];await session.resync();assert.equal(session.events,beforeResync);assert.equal(assembler.snapshot('probe'),beforeSnapshot);assert.equal(session.openState,'error');let release;replies=[()=>new Promise(resolve=>release=resolve)];const stale=session.resync();await drain();replies=[historyReply([10,11,12,13].map(seq=>projectedRow(seq)))];await session.resync();release(historyReply(bad));await stale;assert.equal(session.openState,'open')
    const beforeGap=session.events;session.liveBuffer=[projectedRow(16)];replies=[historyReply([10,11,12,13].map(seq=>projectedRow(seq)))];await session.repairGap();assert.equal(session.openState,'error');assert.equal(session.events,beforeGap);assert.equal(session.liveBuffer.length,1);replies=[historyReply([10,11,12,13,14,15,16].map(seq=>projectedRow(seq)))];await session.loadOlder();assert.equal(session.openState,'open')
    session.hasMore=true;const beforeRace=session.events;let releasePage,releaseRepair;replies=[()=>new Promise(resolve=>releasePage=resolve),()=>new Promise(resolve=>releaseRepair=resolve)];const paging=session.loadOlder();await drain();session.acceptLiveEvent(projectedRow(18).event);await drain();assert.equal(session.stitching,true);releasePage(historyReply([projectedRow(8),projectedRow(9)]));await paging;assert.equal(session.events,beforeRace);assert.equal(session.openState,'open');releaseRepair(historyReply([10,11,12,13,14,15,16,17,18].map(seq=>projectedRow(seq))));await drain();assert.equal(session.stitching,false);assert.deepEqual(Array.from(session.events,event=>event.seq),[10,11,12,13,14,15,16,17,18]);assert.ok(historyCalls>=5)
    const sparse=new Session('sparse',{sessions:{history:async()=>historyReply([2,4,8].map(seq=>projectedRow(seq)))}},{},{conversation});sparse.installWindow([projectedRow(10),projectedRow(12)],true);sparse.openState='open';await sparse.loadOlder();assert.equal(sparse.openState,'open');assert.deepEqual(Array.from(sparse.events,event=>event.seq),[2,4,8,10,12])
  })
  test(`${label}: frozen history LRU keeps scopes/projections, restores anchor ranges, accepts coalesced pages and protects outstanding operations`,async()=>{
    const {SessionManager}=runtimeObjectLayer(label);const conversation=probeConversation();const calls=[];const pageOf=(before=201,sparse=false)=>{const start=Math.max(1,before-50);return{events:Array.from({length:before-start},(_,index)=>start+index).filter(seq=>!sparse||seq%7!==3).map(seq=>projectedRow(seq)),hasMore:start>1}};const api={sessions:{history:async payload=>{calls.push(payload);return{result:{ok:true,value:pageOf(payload.beforeSeq)}}}},subagents:{list:async()=>({result:{ok:true,value:{entries:[],parentAvailable:true}}})}};const remote={commands:{execute:async()=>({ok:true})}};const manager=new SessionManager(api,remote,undefined,undefined,conversation);const select=id=>{if(!manager.summaries.some(row=>row.sessionId===id))manager.summaries.push({sessionId:id,running:false,blank:false,updatedAt:0});manager.select(id);return manager.get(id)}
    const a=select('a');await a.open();await a.loadOlder();await a.loadOlder();assert.equal(a.baseSeq,51);assert.equal(a.events.length,150);a.actx={draft:'retained',attachments:['file-ref']};a.projections.apply('title','retained title',1);const assembler=a.conversation;const b=select('b');await b.open();manager.xhHistoryCache.limits.maxInactiveSessions=0;manager.historyCacheStats();await drain();assert.equal(a.openState,'cold');assert.equal(a.events.length,0);assert.equal(a.conversation,assembler);assert.equal(assembler.inputs.size,0);assert.equal(a.actx.draft,'retained');assert.equal(a.projections.get('title'),'retained title');const before=calls.length;select('a');await a.open();assert.equal(a.baseSeq,51);assert.equal(a.events.length,150);assert.equal(calls.length,before+3);assert.equal(b.openState,'cold')
    a.handleRunning(true);select('b');await b.open();manager.historyCacheStats();assert.equal(a.openState,'open');a.handleRunning(false);a.pending.set('q',{kind:'question'});manager.historyCacheStats();assert.equal(a.openState,'open');a.pending.clear();a.queueMirror.replace([{id:'queue',message:{id:'m',content:[]},placement:'steering'}]);manager.historyCacheStats();assert.equal(a.openState,'open');a.queueMirror.reset();manager.trackPending('a','approval','pending');manager.historyCacheStats();assert.equal(a.openState,'open');manager.resolvePending('a','approval');manager.historyCacheStats();assert.equal(a.openState,'cold')
    manager.xhHistoryCache.limits.maxInactiveSessions=2;select('a');await a.open();const access=manager.xhHistoryCache.entries.get('a').lastAccess;a.handleRunning(true);a.acceptLiveEvent(projectedRow(201).event);a.handleRunning(false);assert.equal(manager.xhHistoryCache.entries.get('a').lastAccess,access);for(const id of ['c','d','e'])await select(id).open();const stats=manager.historyCacheStats();assert.equal(stats.inactiveSessions,2);assert.equal(manager.get('a').openState,'cold');manager.xhHistoryCache.limits.maxInactiveBytes=1;manager.historyCacheStats();assert.equal(manager.historyCacheStats().inactiveSessions,0)
    let release;const c=select('c');c.history=()=>new Promise(resolve=>release=resolve);const opening=c.open();await drain();select('e');manager.historyCacheStats();assert.equal(c.openState,'loading');release({result:{ok:true,value:pageOf()}});await opening;await drain();assert.equal(c.openState,'cold');const count=calls.length;await c.resync();assert.equal(calls.length,count)
    select('c');c.history=async payload=>payload.beforeSeq?{result:{ok:false,error:{message:'offline'}}}:{result:{ok:true,value:pageOf()}};c.xhRestoreBaseSeq=1;await c.open();assert.equal(c.openState,'error');assert.equal(c.xhRestoreBaseSeq,1);c.history=api.sessions.history;await c.open();assert.equal(c.baseSeq,1);c.xhRestoreBaseSeq=51;c.history=async payload=>({result:{ok:true,value:pageOf(payload.beforeSeq,true)}});const sparse=await c.restoreHistoryRange(pageOf(undefined,true),c.openGeneration);assert.ok(sparse.events[0].event.seq<=51);assert.equal(sparse.events.at(-1).event.seq,200);for(const events of [[projectedRow(100),projectedRow(99)],[projectedRow(100),projectedRow(151)],[projectedRow(100),projectedRow(100)]]){c.history=async()=>historyReply(events);await assert.rejects(c.restoreHistoryRange(pageOf(undefined,true),c.openGeneration),/invalid projected page/)}c.xhRestoreBaseSeq=1;for(const events of [[],[projectedRow(190)]])await assert.rejects(c.restoreHistoryRange({events,hasMore:false},c.openGeneration),/no longer available/);c.xhRestoreBaseSeq=undefined;c.history=api.sessions.history
    let finish;remote.commands.execute=()=>new Promise(resolve=>finish=resolve);const command=c.command('fixture');select('e');manager.historyCacheStats();assert.equal(c.openState,'open');finish({ok:true});await command;await drain();assert.equal(c.openState,'cold');manager.drop('c');assert.equal(manager.xhHistoryCache.entries.has('c'),false);assert.equal(c.xhHistoryOwner,undefined)
  })
  test(`${label}: frozen live-answer recovery restores durable compaction suffixes with bounded retries and no prompt resubmission`,async()=>{
    let now=1723500000000;class RecoveryDate extends Date {static now(){return now}}
    const {Session,SessionManager}=runtimeObjectLayer(label,{Date:RecoveryDate,Intl});const conversation=probeConversation();let replies=[],historyCalls=0,promptCalls=0;const failure={result:{ok:false,error:{code:'transport-failure',message:'offline'}}};const api={sessions:{history:async()=>{historyCalls++;return replies.shift()},prompt:async()=>{promptCalls++;return{result:{ok:true,value:{accepted:true}}}}},subagents:{list:async()=>({result:{ok:true,value:{entries:[],parentAvailable:true}}})}};const session=new Session('recover',api,{},{conversation});session.installWindow([projectedRow(40)],true);session.openState='open';session.handleRunning(true);replies=[failure];await session.loadOlder();assert.equal(session.openState,'error');session.acceptLiveEvent(projectedRow(41).event);replies=[historyReply([40,41,42].map(seq=>projectedRow(seq)))];const before=historyCalls;session.handleMuxEnvelope('live',{type:'session/event',sessionId:'recover',event:projectedRow(42).event});assert.equal(historyCalls,before+1);await drain();assert.equal(session.openState,'open');assert.deepEqual(Array.from(session.events,event=>event.seq),[40,41,42]);assert.equal(session.liveBuffer.length,0)
    session.hasMore=true;replies=[failure];await session.loadOlder();const failedCount=historyCalls;for(let seq=43;seq<63;seq++)session.handleMuxEnvelope('live',{type:'session/event',sessionId:'recover',event:projectedRow(seq).event});assert.equal(historyCalls,failedCount);assert.equal(session.liveBuffer.length,20);for(let i=0;i<50;i++)session.handleRunning(true);assert.equal(historyCalls,failedCount);now+=5000;replies=[historyReply(Array.from({length:23},(_,i)=>projectedRow(40+i)))];session.handleRunning(true);await drain();assert.equal(session.openState,'open');assert.equal(historyCalls,failedCount+1)
    const promptSession=new Session('prompt',api,{},{conversation});promptSession.installWindow([projectedRow(20)],true);promptSession.openState='error';promptSession.acceptLiveEvent(projectedRow(21).event);replies=[historyReply([projectedRow(20),projectedRow(21)])];const prior=historyCalls;await promptSession.prompt([{type:'text',text:'queue while running'}],'queue');await drain();assert.equal(promptSession.openState,'open');assert.equal(historyCalls,prior+1);assert.equal(promptCalls,1)
    const manager=new SessionManager(api,{},undefined,undefined,conversation);manager.summaries.push({sessionId:'background',running:false,blank:false,updatedAt:0},{sessionId:'current',running:false,blank:false,updatedAt:0});manager.select('current');const background=manager.get('background');background.installWindow([projectedRow(10)],true);background.openState='open';replies=[failure];await background.loadOlder();const backgroundCount=historyCalls;background.handleRunning(true);background.handleMuxEnvelope('live',{type:'session/event',sessionId:'background',event:projectedRow(11).event});await drain();assert.equal(historyCalls,backgroundCount);assert.equal(background.liveBuffer.length,1);assert.equal(promptCalls,1)
  })
}

test('runtime: complete plugin value exports and injection ABI match the frozen production entry',()=>{
  const a=runtimeFixture('legacy'),b=runtimeFixture('source')
  assert.deepEqual(Object.keys(b.api).filter(key=>key!=='publishChatSnapshot').sort(),Object.keys(a.api).sort());assert.equal(typeof b.api.publishChatSnapshot,'function');assert.deepEqual(Array.from(b.api.inject),Array.from(a.api.inject))
  for(const key of Object.keys(a.api))assert.equal(typeof b.api[key],typeof a.api[key],key)
})

for(const label of ['legacy','source'])test(`${label}: native catalog-updated frames coalesce after initial baseline and replay refresh races`,async()=>{
  const {SessionManager}=runtimeObjectLayer(label);let releaseInitial,releaseRefresh;const initial=new Promise(resolve=>releaseInitial=resolve),refresh=new Promise(resolve=>releaseRefresh=resolve);let requests=0
  const api={sessions:{list:async()=>{requests++;if(requests===1)return initial;if(requests===2)return refresh;return{result:{ok:true,value:{sessions:[]}}}}}}
  const manager=new SessionManager(api,{});const initialLoad=manager.refreshList();const envelope={rpcId:'catalog',payload:{type:'host/remote-event',event:'xharness/catalog-updated',args:[]}};manager.handleHostEnvelope(envelope);manager.handleHostEnvelope(envelope);assert.equal(requests,1);releaseInitial({result:{ok:true,value:{sessions:[]}}});await initialLoad;await drain();assert.equal(requests,2);manager.handleHostEnvelope(envelope);manager.handleHostEnvelope(envelope);releaseRefresh({result:{ok:true,value:{sessions:[]}}});await drain();assert.equal(requests,3);manager.handleHostEnvelope({...envelope,payload:{...envelope.payload,event:'other-event'}});await drain();assert.equal(requests,3)
})

for(const label of ['legacy','source']) test(`${label}: frozen local history reuse skips audited reducers while rebinding fresh locations and rolling back failed views`,async()=>{
  const f=runtimeFixture(label);const calls={start:0,update:0,build:0,location:0};let failView=false
  const definition={kind:'local',target:'probe',historyReuse:'local',match:event=>event.type==='probe'?{id:event.data.id,role:event.data.role}:null,
    start:(_context,match)=>{calls.start++;return{final:match,business:{seq:match.event.seq},hidden:match.event.data.hidden===true}},
    update:(context,match)=>{calls.update++;return{...context.state,final:match}},
    buildViewNode:context=>{calls.build++;return{key:context.key,target:'probe',data:context.state.business,location:context.state.final.location}},
    buildLocationData:()=>{calls.location++;return null}}
  const events={entries:()=>[definition],fallbackEntry:()=>undefined},views={entries:()=>[{target:'probe',create:()=>({empty:[],replace:input=>{if(failView)throw Error('view rollback');return input.nodes},apply:input=>input.upserts})}]}
  const assembler=new f.api.ConversationNodeAssembler(events,views)
  const boundary=(seq,type,turn,step)=>({event:{seq,time:seq,type,data:{turn,...step===undefined?{}:{step}}}})
  const rows=[boundary(10,'turn/start',1),boundary(11,'step/start',1,0),projectedRow(12,'a'),projectedRow(13,'a','update'),boundary(14,'step/end',1,0),boundary(15,'turn/end',1)]
  assembler.replaceWindow(rows,true);assembler.flush();const old=assembler.snapshot('probe')[0],oldState=assembler.contexts.get(f.api.conversationContextKey('local','a')).state
  assert.deepEqual(calls,{start:1,update:1,build:1,location:2})
  const older=[boundary(0,'turn/start',0),boundary(1,'step/start',0,0),projectedRow(2,'old'),boundary(3,'step/end',0,0),boundary(4,'turn/end',0)]
  assert.equal(assembler.prepend(older,false),'immediate');const next=assembler.snapshot('probe').find(node=>node.key===f.api.conversationContextKey('local','a'))
  assert.deepEqual(calls,{start:2,update:1,build:2,location:4},'only the fresh older context runs audited reducers/builders')
  assert.equal(next.data,old.data,'business projection identity is retained')
  assert.notEqual(next.location,old.location,'mutable transaction location is never retained')
  const state=assembler.contexts.get(f.api.conversationContextKey('local','a')).state;assert.equal(state.business,oldState.business);assert.notEqual(state.final,oldState.final)
  assert.equal(state.final.event,oldState.final.event);assert.equal(state.final.location.turn,next.location.turn);assert.equal(state.final.location.step,next.location.step)
  assert.equal(assembler.prepend([],false),'none')
  const snapshot=assembler.snapshot('probe'),inputs=assembler.inputs,locations=assembler.locationIndex
  failView=true;assert.throws(()=>assembler.prepend([projectedRow(-1,'earlier')],false),/view rollback/)
  assert.equal(assembler.snapshot('probe'),snapshot);assert.equal(assembler.inputs,inputs);assert.equal(assembler.locationIndex,locations)
  failView=false
  // Hidden local state is deliberately excluded from identity reuse.
  const hidden={event:{seq:20,time:20,type:'probe',data:{id:'hidden',role:'start',hidden:true}}}
  assembler.replaceWindow([hidden],true);const count=calls.start;assembler.prepend([projectedRow(19,'other')],false)
  assert.equal(calls.start,count+2,'a hidden audited context must replay alongside the newly inserted context')
  await f.dispose()
})

for(const label of ['legacy','source']) test(`${label}: real Core dynamic facade keeps prototype caller tracing and unload-owned slot/theme effects`,async()=>{
  const {api,Context}=cordisApi(label),root=new Context(),trace=[],errors=[],ledger=[]
  class Slots extends Core.Service{
    constructor(ctx){super(ctx,'slots')}
    spec(){return{kind:'single'}}
    register(options,component){trace.push(['slot',this.ctx.scopeName,options.priority,options.key,component]);return this.ctx.effect(()=>()=>trace.push(['slot-off',this.ctx.scopeName]))}
  }
  class Theme extends Core.Service{
    constructor(ctx){super(ctx,'theme')}
    overrideTokens(source,tokens){trace.push(['theme',this.ctx.scopeName,source,tokens]);let alive=true;return()=>{if(alive){alive=false;trace.push(['theme-off'])}}}
  }
  new Slots(root);new Theme(root)
  let facade
  const fiber=root.plugin({name:'fixture-caller',inject:['slots','theme'],apply(caller){
    const ctx=caller.extend({scopeName:'calling-fiber'})
    facade=api.dynamicCordisContext(ctx,{pkg:{pluginId:'p',packageId:'v',pluginRunId:'run'},ledger,claim(){},allocatePriority:()=>-7,reportFailure:error=>errors.push(error)})
    facade.slots.register({name:'tool.view.cordis',key:'self'},'component')
    facade.theme.overrideTokens('ignored-owner',{color:'blue'})
  }})
  await fiber
  assert.deepEqual(trace,[['slot','calling-fiber',-7,'p.v','component'],['theme','calling-fiber','p.v',{color:'blue'}]])
  assert.deepEqual(Object.keys(facade),[],'facade retains the frozen empty-target enumerable ABI')
  assert.deepEqual(json(ledger),[{slot:'tool.view.cordis',priority:-7}]);assert.equal(errors.length,0)
  await fiber.dispose();assert.ok(trace.some(row=>row[0]==='slot-off'&&row[1]==='calling-fiber'));assert.equal(trace.filter(row=>row[0]==='theme-off').length,1)
  await root.fiber.dispose();assert.equal(trace.filter(row=>row[0]==='theme-off').length,1,'early caller teardown is idempotent under root teardown')
})

for(const label of ['legacy','source']) test(`${label}: transport death settles old waits before readiness and preserves new mux-generation baseline`,async()=>{
  const {SessionManager}=runtimeObjectLayer(label),conversation=probeConversation()
  const api={sessions:{history:async()=>historyReply([projectedRow(1)],false),list:async()=>({result:{ok:true,value:{items:[{sessionId:'s',running:false,blank:false,updatedAt:0}]}}})}}
  const manager=new SessionManager(api,{},undefined,undefined,conversation)
  manager.summaries.push({sessionId:'s',running:false,blank:false,updatedAt:0});manager.select('s');const session=manager.get('s');session.installWindow([projectedRow(1)],true);session.openState='open'
  let settled=0;const old={kind:'question',markSettled(){settled++}}
  session.pending.set('old',old);session.subscribedLastSeq=9
  manager.handleDisconnected();assert.equal(settled,1);assert.equal(session.pending.size,0);assert.equal(session.subscribedLastSeq,null)
  const fresh={kind:'question',markSettled(){throw Error('fresh generation was incorrectly settled')}}
  session.pending.set('fresh',fresh);session.subscribedLastSeq=1
  await session.resync();assert.equal(session.openState,'open');assert.equal(session.pending.get('fresh'),fresh);assert.equal(session.subscribedLastSeq,1)
})

function opaqueChatPublication(){
  const foreign={type:'owner/foreign-content',payload:{retained:['not', 'a', 'closed', 'wire', 'union']}}
  const node={key:'foreign:7',kind:'owner.foreign',id:'7',target:'chat',anchorSeq:7,location:{kind:'session'},visibility:'visible',data:foreign}
  const legacyNode={kind:'unknown',seq:7,time:7,type:'owner/foreign',data:foreign}
  const nodes={get(key){assert.equal(this,nodes,'preserve raw reader receiver');return key===node.key?node:undefined},values(){assert.equal(this,nodes);return list}}
  const list=[node],keys=[node.key]
  const locations={getTurn(){assert.equal(this,locations);return keys},getStep(){assert.equal(this,locations);return keys}}
  return {raw:{order:keys,nodes,locations,timeline:{turnOrder:[],turns:new Map()},legacy:{nodes:[legacyNode],turnTimings:undefined,turnEnds:new Map(),partial:null,runningCalls:[]}},node,list,keys,foreign}
}
function rawChatRegistry(raw){
  return {events:{entries:()=>[],fallbackEntry:()=>undefined},views:{entries:()=>[{target:'chat',create:()=>({empty:raw,replace:()=>raw,apply:()=>raw})}]}}
}
for(const label of ['legacy','source'])test(`${label}: valid unbranded JS chat targets retain foreign payloads, live readers, receiver identity and legacy fields`,()=>{
  const {Session}=runtimeObjectLayer(label),f=opaqueChatPublication()
  const session=new Session('raw-target',{}, {},{conversation:rawChatRegistry(f.raw)})
  const snapshot=session.getSnapshot(),chat=snapshot.chat
  assert.equal(snapshot.composerPhase,'active');assert.equal(chat.order,f.raw.order);assert.equal(chat.legacy,f.raw.legacy);assert.equal(chat.timeline,f.raw.timeline)
  assert.equal(chat.nodes.get(f.node.key),f.node);assert.equal(chat.nodes.values(),f.list);assert.equal(chat.locations.getTurn(1),f.keys);assert.equal(chat.locations.getStep(1,0),f.keys)
  assert.equal(snapshot.nodes,f.raw.legacy.nodes);assert.equal(snapshot.nodes[0].data,f.foreign);assert.equal(snapshot.turnTimings,undefined);assert.equal(snapshot.turnEnds,f.raw.legacy.turnEnds)
  assert.equal(session.getSnapshot(),snapshot,'cached Session snapshot remains stable')
})
test('source: raw chat compatibility boundary validates callable results instead of falsely promising a generic DTO',()=>{
  const {readChatSnapshot}=sourceModule('client-runtime',{Map,Set},{},'sessions/chat-snapshot-codec')
  const f=opaqueChatPublication(),chat=readChatSnapshot(f.raw)
  assert.notEqual(chat,f.raw,'only unknown reader interfaces receive checked adapters');assert.equal(readChatSnapshot(f.raw),chat)
  assert.equal(chat.nodes.get(f.node.key),f.node);assert.equal(chat.nodes.values(),f.list)
  f.raw.nodes.get=()=>({key:'broken',data:f.foreign});assert.throws(()=>chat.nodes.get('broken'),/invalid node/)
  f.raw.nodes.values=()=>[f.node,null];assert.throws(()=>chat.nodes.values(),/invalid nodes/)
  f.raw.locations.getTurn=()=>[1];assert.throws(()=>chat.locations.getTurn(1),/invalid key list/)
  f.raw.locations.getStep=undefined;assert.throws(()=>chat.locations.getStep(1,0),/not callable/)
  assert.throws(()=>readChatSnapshot({...f.raw,legacy:{nodes:[],partial:null,runningCalls:[],turnEnds:'not a Map'}}),/invalid chat view publication/)
})
test('source: typed Chat publication is identity preserving and crosses the real Session erased-target boundary without adapters',async()=>{
  const f=runtimeFixture('source',{},externals=>sourceModule('client-runtime',{Map,Set},externals,'test-exports'))
  const raw=opaqueChatPublication().raw
  assert.equal(f.api.publishChatSnapshot(raw),raw)
  const session=new f.api.Session('typed-target',{}, {},{conversation:rawChatRegistry(raw)})
  assert.equal(session.getSnapshot().chat,raw)
  await f.dispose()
})


for(const label of ['legacy','source'])test(`${label}: real Core runner boot consumes the one independently preloaded module system and owns unload`,async()=>{
  const {api,Context}=cordisApi(label),ctx=new Context(),syncs=[],events=new Map(),invalidated=[]
  // This is created by the separate preloaded modules factory, not a class
  // inlined into the runner's private source closure.
  const {system}=create(current)
  const original=system.invalidate
  system.invalidate=function(id){assert.equal(this,system);invalidated.push(id);return Reflect.apply(original,this,[id])}
  const slots={snapshot:()=>[],onEntryError:()=>()=>{},spec:()=>undefined,getSnapshot:()=>[]}
  ctx.provide('modules',system);ctx.provide('slots',slots)
  ctx.provide('loader',{create:async()=>{throw Error('no dynamic load during boot')},resolve:()=>undefined,remove:async()=>{}})
  class Remote extends Core.Service{
    constructor(root){super(root,'remote')}
    dynamicCordisRunner={syncInspectManifest:async providers=>{syncs.push(providers);return{ok:true,value:{}}},resolveInspectQuery:async()=>({ok:true,value:{}})}
    $on(name,listener){events.set(name,listener);return this.ctx.effect(()=>()=>events.delete(name))}
  }
  new Remote(ctx)
  ctx.provide('remote.dynamicCordisRunner',ctx.get('remote').dynamicCordisRunner)
  await ctx.plugin({name:'actual-runner',inject:api.inject,apply:api.apply})
  await drain();const runner=ctx.get('dynamicCordisRunner');assert.ok(runner)
  assert.equal(ctx.get('modules'),system);assert.ok(syncs.length>0);assert.equal(syncs[0].length,5);assert.equal(events.size,5);assert.equal(invalidated.length,0)
  await ctx.fiber.dispose();assert.equal(events.size,0)
})
