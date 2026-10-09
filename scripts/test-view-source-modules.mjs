import {loadOwnedCordisRuntime} from './fixtures/owned-view-cordis-runtime.mjs'
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {readFileSync} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import {compileSourceModules} from './build-source-modules.mjs'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const Core=loadOwnedCordisRuntime()
const modules = ['jobs', 'skill', 'plan', 'reference', 'brand-official', 'deliverables', 'sidebar', 'layout', 'goal', 'subagent', 'message-feedback', 'workflow-run', 'theme', 'input-trigger', 'commands', 'settings', 'settings-general', 'settings-plugin-inventory', 'settings-plugins']
const output = join(repo, 'ui/src/modules')
const sourceOutputs=compileSourceModules(join(repo,'ui'),modules.map(name=>({id:`@xharness/dsh-client-ui-${name}`,source:`src/modules/${name}/index.ts`})))

function makeLoader(source) {
  const modulesCache = new Map()
  const effects = []
  const windowEvents=[]
  const react = {
    Fragment: 'fragment',
    useId: () => 'view-id',
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: value => ({current: value}), useEffect: callback => effects.push(callback),
    useLayoutEffect: callback => effects.push(callback), useMemo: callback => callback(), useCallback: callback => callback, memo: component => component,
  }
  const jsx = (type, props, key) => ({type, props, ...(key === undefined ? {} : {key})})
  const primitives = new Proxy({useDismissOnOutsidePointer() {}}, {get: (target, key) => target[key] ?? `primitive:${String(key)}`})
  const external = {
    '@xharness/cordis': Core,
    '@xharness/dsh-client-ui-slots': {resolveSlotLabel: label => typeof label === 'function' ? label() : label},
    react, 'react/jsx-runtime': {jsx, jsxs: jsx, Fragment: 'fragment'},
    '@xharness/dsh-client-ui-primitives': primitives,
    'react-dom': {createPortal: children => children},
    '@xharness/dsh-client-runtime/client': {createSnapshotStore: initial => {let state = initial; const listeners = new Set(); return {getSnapshot: () => state, subscribe: listener => {listeners.add(listener); return () => listeners.delete(listener)}, set: value => {if (state === value) return; state = value; for (const listener of listeners) listener()}, update: edit => {const draft = {...state}; edit(draft); state = draft; for (const listener of listeners) listener()}}}, isAppendSurfaceEvent: event => event.surface !== 'replace', defineStore: spec => ({spec}), shallowEqual: (left, right) => JSON.stringify(left) === JSON.stringify(right), indexSubagentDescendants: rows => {
      const result = new Map()
      for (const row of Object.values(rows)) {
        const parent = row.parentId; if (!parent || row.origin !== 'subagent') continue
        const previous = result.get(parent) ?? {count: 0, runningCount: 0}
        result.set(parent, {count: previous.count + 1, runningCount: previous.runningCount + Number(row.running)})
      }
      return result
    }},
  }
  function evaluated(name) {
    if(modulesCache.has(name))return modulesCache.get(name)
    const id=`@xharness/dsh-client-ui-${name}`
    let declaration
    let bytes=source?sourceOutputs.get(id).bytes.toString():readFileSync(join(repo,`ui/reference/master-a613970/plugins/${id}/client.js`),'utf8')
    if(source){
      const pattern=/return __load\(("[^"\n]+")\);\n\}\n\}\);\s*$/
      assert.ok(pattern.test(bytes),'owned production compiler return must exist for test-only internal seam')
      bytes=bytes.replace(pattern,'return { public: __load($1), internal: __load };\n}\n});')
    }
    vm.runInNewContext(bytes,{window:{dispatchEvent:event=>{windowEvents.push({type:event.type,...event instanceof CustomEvent?{detail:event.detail}:{}});return true},__ModuleLoader__:{load:value=>{declaration=value}}},console,AbortController,setInterval,clearInterval,Date,Event,CustomEvent})
    const api=declaration.factory(id=>{
      if(id in external)return external[id]
      throw new Error(`Unexpected external: ${id}`)
    })
    modulesCache.set(name,api)
    return api
  }
  function load(file){
    const local=file.slice(output.length+1)
    const name=local.split('/')[0]
    assert.ok(modules.includes(name),'internal unit belongs to an accepted source module')
    assert.ok(source,'frozen tests use public factory or explicit existing lexical seams')
    return evaluated(name).internal(`src/modules/${local}`)
  }
  function entry(name){const api=evaluated(name);return source?api.public:api}
  return {entry, load, effects, react, windowEvents}
}

function context() {
  const registrations = []; const namespaces = []; const sources = []; const disposers = []
  const listeners = new Map(); const trace = []; let catalog = []
  const sessions = {subagentAddress: () => undefined}
  const connection = {isLoopback: true, hostDescription: {getSnapshot: () => ({canOpenPath: true}), subscribe: () => () => {}}, api: {credentials: {describe: async () => ({result: {ok: true, value: {credentials: {}}}}), set: async () => ({result: {ok: true, value: null}})}, settings: {describe: async () => ({result: {ok: true, value: {namespaces: [], writable: true, hasDocument: true}}})}, skills: {list: async (request, signal) => {
    trace.push({request, signal}); return {result: {ok: true, value: {skills: catalog}}}
  }}}}
  const fixture = {
    plugin: Constructor => new Constructor(ctx),
    inject: (_names, callback) => callback(ctx),

    emit: (name, value) => listeners.get(name)?.(value),
    effect: (effect, label) => {if (label === 'ui-layout: theme presenter') return; const dispose = effect(); if (typeof dispose === 'function') disposers.push(dispose); return () => {if (typeof dispose === 'function') dispose()}},
    locale: {getSnapshot: () => ({revision: 0}), subscribe: () => () => {}, register: (ns, dictionaries) => namespaces.push({ns, dictionaries}), bind: () => key => key},
    slots: {
      getVersion: () => 0, entries: () => [], subscribe: () => () => {},
      inject: (_name, effect) => {const value = effect(); if (typeof value === 'function') disposers.push(value); if (value && Symbol.iterator in Object(value)) Array.from(value)},
      register: (spec, component) => {registrations.push({spec, component}); return () => {}},
    },
    get: name => ({connection, remote: ctx.remote, locale: ctx.locale, sessions: ctx.sessions, inputTriggers: {registerSource: source => {sources.push(source); return () => {trace.push('unregister')}}}}[name]),
    on: (name, listener) => {listeners.set(name, listener); return () => {}},
    remote: {
      pluginInventory: {list: async () => ({ok: true, value: {entries: []}})},
      $on: (name, listener) => {listeners.set(name, listener); return () => {}},
      commands: {list: async () => ({ok: true, value: []}), execute: async (...args) => {trace.push(args); return {ok: true, value: {}}}},
      fileReferences: {list: async () => ({ok: true, value: [{kind: 'file', path: 'space name.ts'}, {kind: 'directory', path: 'src'}, {kind: 'file', path: 'bad"name'}]})},
      sessionReferenceResolver: {candidates: async () => ({ok: true, value: [{sessionId: 's2', label: 'Other', mention: '@session:s2', createdAt: 0}]})},
      goals: Object.fromEntries(['edit', 'pause', 'resume', 'clear', 'complete'].map(name => [name, async (...args) => {trace.push({method: name, args}); return {ok: true, value: null}}])),
    },
    sessions: {
      subagentAddress: () => undefined,
      scope: id => ({effect: effect => {const dispose = effect(); if (typeof dispose === 'function') disposers.push(dispose)}, bail: () => true, sessionId: id}),
      scopeOf: scope => scope.sessionId,
      binding: () => ({session: {projections: {faceOf: () => ({getSnapshot: () => ({goal: {id: 'g', revision: 2}})})}}}),
      openSubagent: address => {trace.push({openSubagent: address})},
      refreshSubagents: async id => {trace.push({refreshSubagents: id})},
      setSubagentCatalogOpen: (id, open) => {trace.push({catalog: id, open})},
      open: id => {trace.push({openSession: id})},
    },
    settingsScope: {describe: () => ({getSnapshot: () => ({status: 'ready', view: {namespaces: [], writable: true, hasDocument: true}, error: null}), subscribe: () => () => {}, ensure: async () => {}, acceptView: () => {}}), bind: () => ({getSnapshot: () => ({value: {preference: 'system'}}), subscribe: () => () => {}, set: async () => ({ok: true, value: {preference: 'system'}})})},
    events: {dispatch: () => []}, logger: {warn: () => {}},
    reflect: {provide: (name, value) => {Object.defineProperty(ctx,name,{value,writable:true,configurable:true}); return () => {trace.push(`dispose:${name}`)}}},
    workspaces: {startSession: id => {trace.push({workspace: id})}},
    layout: {toggleSidebar: () => {trace.push('toggleSidebar')}},
    conversationEvents: {register: definition => {Object.defineProperty(ctx,'definition',{value:definition,writable:true,configurable:true})}},
    provide: (name, value) => {Object.defineProperty(ctx,name,{value,writable:true,configurable:true})},
  }
  // Domain algorithms run against the documented Core context prototype (Core.Context.is
  // expressly accepts prototypes), not a fake Service constructor. This is intentionally
  // not a tracker/fiber fixture; those behaviors use real contexts in test-owned-cordis-services.
  const ctx=Object.create(Core.Context.prototype)
  for(const [key,value] of Object.entries(fixture))Object.defineProperty(ctx,key,{value,writable:true,configurable:true})
  return {ctx, registrations, namespaces, sources, listeners, trace, disposers, setCatalog: value => {catalog = value}}
}
function normalized(value) {
  // bake is a private typed StoreSpec adapter, not a published Slot declaration.
  // Its runtime binding behavior is verified using the real engine persistence fixture.
  return JSON.parse(JSON.stringify(value, (key, item) => key==='bake' && typeof item==='function'?undefined:typeof item === 'function' ? `[function:${item.name}]` : item))
}
const legacy = makeLoader(false); const current = makeLoader(true)
for (const name of modules) {
  test(`${name}: factory declarations and slot identities match frozen production`, () => {
    const before = legacy.entry(name); const after = current.entry(name)
    assert.deepEqual(normalized(after.inject), name === 'layout' ? [...normalized(before.inject), 'sessions'] : normalized(before.inject))
    const one = context(); const two = context()
    before.apply(one.ctx); after.apply(two.ctx)
    const namespaces = normalized(one.namespaces)
    if (name === 'sidebar') {
      Object.assign(namespaces[0].dictionaries.en, {'navigation.back':'Back','navigation.forward':'Forward'})
      Object.assign(namespaces[0].dictionaries.zh, {'navigation.back':'后退','navigation.forward':'前进'})
    }
    if (name === 'settings-general') {
      // Reviewed account-menu addition; all pre-existing copy remains frozen.
      Object.assign(namespaces[0].dictionaries.zh, {
        'account.trigger':'账号与设置','account.name':'XHarness','account.caption':'账号与设置',
        'account.local':'本机工作区','account.menu':'账号与额度','account.profile':'使用档案',
      })
      Object.assign(namespaces[0].dictionaries.en, {
        'account.trigger':'Account & settings','account.name':'XHarness','account.caption':'Account & settings',
        'account.local':'Local workspace','account.menu':'Account & allowance','account.profile':'Usage profile',
      })
    }
    assert.deepEqual(normalized(two.namespaces), namespaces)
    const expected = normalized(one.registrations.map(({spec}) => spec))
    if (name === 'layout') Object.assign(expected[0].children, {
      'work.center.tasks': {kind: 'single', scope: 'root'},
      'work.center.automations': {kind: 'single', scope: 'root'},
      'review.center': {kind: 'single', scope: 'root'},
      'assistant.center': {kind: 'single', scope: 'root'},
    })
    if (name === 'sidebar') Object.assign(expected[0].children, {
      'sidebar.primary.action': {kind: 'list', scope: 'root'},
    })
    if (name === 'settings-general') {
      expected[0].children['settings.account-entry'] = {kind:'single',scope:'root'}
      expected.splice(2, 0, {name:'settings.account-entry',locale:'settings'})
    }
    assert.deepEqual(normalized(two.registrations.map(({spec}) => spec)), expected)
  })
}
for (const [label, loader] of [['legacy', legacy], ['source', current]]) {
  test(`${label}: job action remains absent for empty sessions and shows only live count`, () => {
    const env = context(); loader.entry('jobs').apply(env.ctx)
    const component = env.registrations[0].component
    const t = (key, values) => `${key}:${values?.count ?? ''}`
    assert.equal(component({sessionId: 's', useSessions: select => select({jobsBySession: {}}), t}), null)
    const element = component({sessionId: 's', useSessions: select => select({jobsBySession: {s: [
      {id: 'a', status: 'running', startedAt: 1}, {id: 'b', status: 'failed', startedAt: 2},
    ]}}), t})
    assert.equal(element.props.children[0].props['aria-label'], 'count.live.one:1')
    assert.equal(element.props.children[0].props['aria-expanded'], false)
  })
  test(`${label}: skill catalog single flight, invalidation, aborted caller and cleanup`, async () => {
    const env = context(); loader.entry('skill').apply(env.ctx)
    env.setCatalog([{name: 'github', description: 'GitHub', modelInvocable: true}, {name: 'private', description: 'Manual', modelInvocable: false}])
    const source = env.sources[0]; const signal = new AbortController().signal
    const results = await Promise.all([source.candidates({sessionId: 's'}, {query: '', signal}), source.candidates({sessionId: 's'}, {query: 'git', signal})])
    assert.equal(env.trace.length, 1); assert.equal(results[0][1].description, 'menu.userOnly · Manual')
    assert.deepEqual(normalized(source.lexicon({sessionId: 's'})), ['github', 'private'])
    assert.equal(source.onPick({candidate: {name: 'github'}}).text, '/github ')
    const aborted = new AbortController(); aborted.abort()
    assert.equal((await source.candidates({sessionId: 's'}, {query: '', signal: aborted.signal})).length, 0)
    env.listeners.get('agent-preset/selected')('s')
    assert.equal(env.trace[0].signal.aborted, true)
    await source.candidates({sessionId: 's'}, {query: '', signal}); assert.equal(env.trace.length, 2)
    env.disposers.forEach(dispose => dispose()); assert.ok(env.trace.includes('unregister'))
  })
  test(`${label}: references preserve file-first order, quoted paths, directory continuation and cancellation`, async () => {
    const env = context(); loader.entry('reference').apply(env.ctx)
    const source = env.sources[0]; const signal = new AbortController().signal
    const candidates = await source.candidates({sessionId: 's'}, {query: '', signal})
    assert.equal(candidates.length, 3)
    assert.equal(source.onPick({candidate: candidates[0]}).insert.ref, '@"space name.ts"')
    assert.deepEqual(normalized(source.onPick({candidate: candidates[1]})), {text: '@src/', continue: true})
    assert.equal(source.onPick({candidate: candidates[2]}).insert.appearance, 'session')
    assert.equal((await source.candidates({sessionId: 's'}, {query: '', quoted: true, signal})).length, 2)
    const aborted = new AbortController(); aborted.abort()
    assert.equal((await source.candidates({sessionId: 's'}, {query: '', signal: aborted.signal})).length, 0)
  })
  test(`${label}: plan chip exits using command transport, observes projection and renders disabled state`, async () => {
    const env = context(); loader.entry('plan').apply(env.ctx)
    const {spec, component} = env.registrations[0]
    assert.equal(await spec.inject('s').exitPlanMode(), null)
    assert.deepEqual(normalized(env.trace[0]), ['s', '/plan off', []])
    const props = {useProjection: () => undefined, locked: true, exitPlanMode: async () => null, t: key => key}
    assert.equal(component(props), null)
    const active = component({...props, useProjection: () => ({active: true, pending: false})})
    assert.equal(active.props.children[0].props.disabled, true)
  })
  test(`${label}: produced files use durable successful mutations, deduplicate and exclude later settlements`, () => {
    const env = context(); const api = loader.entry('deliverables'); api.apply(env.ctx)
    const definition = env.ctx.definition
    const start = {type: 'turn/start', seq: 1, data: {turn: 2}}
    let state = definition.start({}, {event: start})
    state = definition.update({state}, {event: {type: 'tool/call', seq: 2, data: {turn: 2, callId: 'c'}}, view: {for: 'call', view: {card: 'diff', locations: [{path: 'src/a.ts'}, {path: 'src/a.ts'}]}}})
    const result = {type: 'tool/result', seq: 3, data: {turn: 2, message: {source: {callId: 'c'}, content: [{isError: true}]}}}
    assert.equal(definition.update({state}, {event: result}), state)
    state = definition.update({state}, {event: {...result, data: {...result.data, message: {...result.data.message, content: [{isError: false}]}}}})
    assert.deepEqual(normalized(api.producedForClosing(state, 3)), ['src/a.ts'])
    assert.deepEqual(normalized(api.producedForClosing(state, 2)), [])
    assert.equal(definition.buildLocationData({state}, 'turn').value.produced.length, 2)
  })
}
test('source: skill row malformed streaming prefixes and interrupted result remain readable', () => {
  const env = context(); current.entry('skill').apply(env.ctx)
  const component = env.registrations[0].component
  for (const [block, state] of [[{callId: 'c', argsRaw: '{"name":'}, 'running'], [{kind: 'result', callId: 'c', content: [], error: {name: 'Error', code: 'interrupted'}, isError: true}, 'stopped']]) {
    assert.equal(component({block, t: key => key}).props['data-state'], state)
  }
})
test('source: fitting and file mentions retain exact disambiguation', () => {
  const model = current.load(join(output, 'deliverables/turn-deliverables.js'))
  const view = current.load(join(output, 'deliverables/ProducedFiles.js'))
  assert.equal(view.fitProducedFiles(50, 5, [20, 20, 20], [10, 10, 10, undefined]), 1)
  const opened = []; const mentions = model.producedFileMentions(['a/x.ts', 'b/x.ts', 'b/y.ts'], path => opened.push(path), path => path)
  assert.equal(mentions.resolve('x.ts'), undefined)
  mentions.resolve('y.ts').open(); assert.deepEqual(opened, ['b/y.ts'])
})
for (const [label, loader] of [['legacy', legacy], ['source', current]]) {
  test(`${label}: root layout actions preserve closed/open/narrow state and wired lifetime`, () => {
    const env = context(); loader.entry('layout').apply(env.ctx)
    const registration = env.registrations[0]
    const {spec} = registration.spec.store()
    let state = spec.init()
    assert.deepEqual(normalized(state), {sidebar: 280, details: 0, narrow: false, narrowExpanded: false})
    spec.actions.setSidebar(state, 10); assert.equal(state.sidebar, 264)
    spec.actions.setDetails(state, 900); assert.equal(state.details, 520)
    spec.actions.setNarrow(state, true); spec.actions.toggleSidebar(state); assert.equal(state.narrowExpanded, true)
    spec.actions.setNarrow(state, false); assert.equal(state.narrowExpanded, false)
    spec.actions.toggleSidebar(state); assert.equal(state.sidebar, 0)
    spec.actions.toggleSidebar(state); assert.equal(state.sidebar, 280)
    assert.throws(() => env.ctx.layout.openDetails(), /not wired/)
    registration.spec.inject(Object.fromEntries(Object.entries(spec.actions).map(([name, action]) => [name, (...args) => action(state, ...args)])))
    const closedEvents=loader.windowEvents.length
    env.ctx.layout.closeDetails(); assert.equal(state.details, 0)
    assert.deepEqual(normalized(loader.windowEvents.slice(closedEvents)),[{type:'xharness:workspace-close-tool'}],'closing details notifies the native-pane occlusion lifecycle')
    const openEvents=loader.windowEvents.length
    env.ctx.layout.openDetails(); assert.equal(state.details, 360)
    assert.deepEqual(normalized(loader.windowEvents.slice(openEvents)),[{type:'xharness:workspace-open',detail:{kind:'tool'}}],'opening details selects the workspace tool pane')
    env.disposers.forEach(dispose => dispose()); assert.ok(env.trace.includes('dispose:layout'))
  })
  test(`${label}: sidebar shell service callbacks remain independent of browsing implementation`, () => {
    const env = context(); loader.entry('sidebar').apply(env.ctx)
    const actions = env.registrations[0].spec.inject()
    actions.startSession('workspace'); actions.toggleSidebar()
    assert.deepEqual(normalized(env.trace), [{workspace: 'workspace'}, 'toggleSidebar'])
    assert.deepEqual(Object.keys(env.registrations[0].spec.children), ['sidebar.brand.mark', 'sidebar.brand.name', 'sidebar.workspaces', 'sidebar.settings', 'sidebar.footer.action', ...(label==='source'?['sidebar.primary.action']:[])])
  })
  test(`${label}: goal dock preserves completion/budget verbs, reads fresh CAS and projects command bubble`, async () => {
    const env = context(); loader.entry('goal').apply(env.ctx)
    const actions = env.registrations[1].spec.inject('s')
    await actions.onBudget(99); await actions.onComplete()
    assert.deepEqual(normalized(env.trace), [{method: 'edit', args: ['s', {id: 'g', revision: 2}, {maxGoalRounds: 99}]}, {method: 'complete', args: ['s', {id: 'g', revision: 2}]}])
    env.ctx.sessions.binding = () => undefined
    assert.equal((await actions.onClear()).error.code, 'no-current-goal'); assert.equal(env.trace.length, 2)
    const event = {type: 'command/run', seq: 4, time: 100, data: {name: 'goal', commandId: 'c', args: ' build tests  '}}
    const definition = env.ctx.definition
    const state = definition.start({}, {event})
    const node = definition.buildViewNode({state, key: 'k', id: 'c'})
    assert.equal(node.anchorSeq, 3.9); assert.equal(node.data.text, '/goal build tests')
  })
  test(`${label}: subagent navigation and parent-offline selector preserve interrupt ownership`, async () => {
    const env = context(); loader.entry('subagent').apply(env.ctx)
    const catalog = env.registrations[0]; const actions = catalog.spec.inject('parent')
    actions.openChild({parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable'})
    actions.refresh('parent'); actions.setCatalogOpen('parent', true)
    assert.deepEqual(normalized(env.trace), [
      {openSubagent: {parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable'}},
      {refreshSubagents: 'parent'}, {catalog: 'parent', open: true},
    ])
    const select = env.registrations[1].spec.select
    assert.equal(select({}), null)
    assert.equal(select({session: {running: true, subagent: {address: {mode: 'continuable'}, parentAvailable: false}}}), null)
    assert.deepEqual(normalized(select({session: {running: false, subagent: {address: {mode: 'continuable'}, parentAvailable: false}}})), {reason: 'parent-unavailable'})
    assert.deepEqual(normalized(select({session: {running: true, subagent: {address: {mode: 'one-shot'}, parentAvailable: true}}})), {reason: 'one-shot'})
    assert.equal(catalog.component({sessionId: 'parent', useSessions: pick => pick({subagentsByParent: {}, byId: {}}), ...actions, t: key => key}), null)
  })
  test(`${label}: feedback shares one lazy list, serializes CAS mutations, retracts and disposes`, async () => {
    const env = context(); let item = null; let writes = 0
    env.ctx.remote.messageFeedback = {
      list: async request => {env.trace.push({method: 'list', request}); return {ok: true, value: {ok: true, value: {items: item ? [item] : []}}}},
      put: async request => {
        env.trace.push({method: 'put', request})
        item = {...request, version: `v${++writes}`, createdAt: 0, updatedAt: writes}
        return {ok: true, value: {ok: true, value: item}}
      },
      delete: async request => {env.trace.push({method: 'delete', request}); item = null; return {ok: true, value: {ok: true, value: {absent: true}}}},
    }
    loader.entry('message-feedback').apply(env.ctx)
    const inject = env.registrations[0].spec.inject
    const actions = inject('s'); assert.equal(actions.hooks.feedback, inject('s').hooks.feedback)
    await Promise.all([actions.ensure(), actions.ensure()]); assert.equal(env.trace.length, 1)
    await actions.rate('m', 'positive', 'a note'); assert.equal(env.trace[1].request.ifVersion, null)
    await actions.clearNote('m'); assert.equal(env.trace[2].request.ifVersion, 'v1'); assert.equal('note' in env.trace[2].request, false)
    await actions.toggle('m', 'positive'); assert.equal(env.trace[3].method, 'delete'); assert.equal(env.trace[3].request.ifVersion, 'v2')
    assert.equal(actions.hooks.feedback.getSnapshot().items.size, 0)
    env.disposers.forEach(dispose => dispose())
    assert.equal((await actions.rate('m', 'negative')).error.code, 'disposed')
    assert.equal(env.trace.length, 4)
  })
  test(`${label}: feedback conflicts reconcile authoritative version and carrier errors remain retryable`, async () => {
    const env = context(); let failList = true
    const authoritative = {messageId: 'm', rating: 'negative', version: 'remote-v', createdAt: 0, updatedAt: 2}
    env.ctx.remote.messageFeedback = {
      list: async () => failList ? {ok: false, error: {code: 'offline', message: 'disconnected'}} : {ok: true, value: {ok: true, value: {items: []}}},
      put: async () => ({ok: true, value: {ok: false, error: {code: 'version-conflict', current: authoritative}}}),
      delete: async request => {env.trace.push(request); return {ok: true, value: {ok: true, value: {absent: true}}}},
    }
    loader.entry('message-feedback').apply(env.ctx)
    const actions = env.registrations[0].spec.inject('s')
    assert.equal((await actions.ensure()).error.code, 'offline'); failList = false
    assert.equal((await actions.rate('m', 'positive')).error.code, 'version-conflict')
    assert.equal(actions.hooks.feedback.getSnapshot().items.get('m').version, 'remote-v')
    await actions.toggle('m', 'negative'); assert.equal(env.trace[0].ifVersion, 'remote-v')
  })
  test(`${label}: workflow folds durable members, preserves absent/empty phases and projects interruption`, () => {
    const env = context(); loader.entry('workflow-run').apply(env.ctx)
    const definition = env.ctx.definition
    const event = {type: 'tool-workflow/run-start', seq: 1, data: {runId: 'r', name: 'Build'}}
    let state = definition.start({}, {event})
    for (const [seq, phase] of [[2, undefined], [3, ''], [4, 'compile']]) {
      const next = {type: 'tool-workflow/agent-start', seq, data: {runId: 'r', seq, childId: `s${seq}`, label: `Member${seq}`, ...(phase === undefined ? {} : {phase})}}
      assert.equal(definition.match(next).role, 'update')
      state = definition.update({state}, {event: next})
    }
    state = definition.update({state}, {event: {type: 'tool-workflow/agent-end', seq: 5, data: {runId: 'r', seq: 2, outcome: 'completed'}}})
    let node = definition.buildViewNode({state, start: {event, location: {kind: 'step', step: {status: 'closed'}, turn: {status: 'open'}}}, key: 'k', id: 'r'})
    assert.equal(node.data.status, 'interrupted')
    assert.deepEqual(normalized(node.data.phases.map(phase => phase.key)), ['missing', 'value:0:', 'value:7:compile'])
    assert.equal(node.data.phases[0].members[0].status, 'completed'); assert.equal(node.data.phases[1].members[0].status, 'interrupted')
    state = definition.update({state}, {event: {type: 'tool-workflow/run-end', seq: 6, data: {runId: 'r', stopReason: 'error'}}})
    node = definition.buildViewNode({state, start: {event, location: {kind: 'turn', turn: {status: 'open'}}}, key: 'k', id: 'r'})
    assert.equal(node.data.status, 'failed')
    env.registrations[0].spec.inject().openSession('s2'); assert.deepEqual(normalized(env.trace), [{openSession: 's2'}])
  })
}
test('source: goal completion stays visible and same-render action dedupe survives network failure', async () => {
  const api = current.entry('goal'); const goal = {id: 'g', revision: 2, objective: 'Done', phase: 'complete', maxGoalRounds: 100}
  const handlers = Object.fromEntries(['onComplete', 'onBudget', 'onEdit', 'onPause', 'onResume', 'onClear'].map(name => [name, async () => ({ok: true, value: null})]))
  const view = api.GoalBar({goal, projection: {goal, execution: {state: 'complete', roundsStarted: 2}}, ...handlers, t: key => key})
  assert.notEqual(view, null); assert.equal(view.props.children.props.children[1].props.children, '已完成 · 2/100 轮')
  const controls = view.props.children.props.children[4].props.children.at(-1)
  let settle; let requests = 0
  const runAction = controls.props.runAction
  const inFlight = runAction(() => {requests++; return new Promise(resolve => {settle = resolve})})
  assert.equal(await runAction(async () => {requests++; return {ok: true, value: null}}), undefined)
  assert.equal(requests, 1); settle({ok: true, value: null}); await inFlight
  assert.equal((await runAction(async () => {throw new Error('offline')})).error.code, 'network')
  assert.equal((await runAction(async () => ({ok: true, value: null}))).ok, true)
})
test('source: column concession retains preferences across squeeze/widen and closed rail geometry', () => {
  const {computeColumns} = current.load(join(output, 'layout/columns.js'))
  assert.deepEqual(normalized(computeColumns(1400, 280, 360)), {sidebar: 280, center: 760, details: 360})
  assert.deepEqual(normalized(computeColumns(1000, 280, 360)), {sidebar: 280, center: 720, details: 0})
  assert.deepEqual(normalized(computeColumns(1400, 280, 360)), {sidebar: 280, center: 760, details: 360})
  assert.equal(computeColumns(400, 0, 0).sidebar, 56)
})

for (const [label, loader] of [['legacy', legacy], ['source', current]]) {
  test(`${label}: theme preference adoption, override layer CAS and registry disposal retain palette semantics`, async () => {
    const env = context(); let persisted = {preference: 'dark'}; let notify
    const writes = []
    env.ctx.settingsScope.bind = () => ({getSnapshot: () => ({value: persisted}), subscribe: listener => {notify = listener; return () => {notify = undefined}}, set: async (field, value) => {writes.push({field, value}); return {ok: true, value: {preference: value}}}})
    const themeModule = loader.entry('theme'); themeModule.apply(env.ctx)
    const theme = env.ctx.theme
    assert.equal(theme.getTheme().active.colorScheme, 'dark')
    assert.ok(Object.isFrozen(theme.getTheme()))
    const tokens = {'--test': {light: 'white', dark: 'black'}}
    const removeOld = theme.overrideTokens('owned', tokens)
    tokens['--test'].dark = 'caller-mutation'
    assert.equal(theme.getTheme().active.tokens['--test'], 'black')
    const removeNew = theme.overrideTokens('owned', {'--test': {light: 'pink', dark: 'red'}})
    removeOld()
    assert.equal(theme.getTheme().active.tokens['--test'], 'red')
    theme.setTheme('light'); assert.equal(theme.getTheme().active.tokens['--test'], 'pink')
    assert.deepEqual(normalized(writes), [{field: 'preference', value: 'light'}])
    const revision = theme.getTheme().revision; theme.setTheme('light')
    assert.equal(theme.getTheme().revision, revision)
    persisted = {preference: 'system'}; notify()
    assert.equal(theme.getTheme().preference, 'system')
    assert.equal(theme.getTheme().active.colorScheme, 'light')
    assert.throws(() => theme.overrideTokens('invalid', {'--bad': 'raw'}), /bare string/)
    assert.throws(() => theme.overrideTokens('invalid', {'--bad': {light: 'x'}}), /pair of strings/)
    assert.throws(() => theme.register({id: 'system', colorScheme: 'dark', tokens: {}}), /not a registrable/)
    assert.throws(() => theme.setTheme('unknown'), /not registered/)
    const removeCustom = theme.register({id: 'custom', colorScheme: 'dark', tokens: {'--extra': 'x'}})
    theme.setTheme('custom'); assert.equal(theme.getTheme().active.colorScheme, 'dark')
    const inspection = theme.exportInspectTokens()
    assert.ok(inspection.some(token => token.name === '--extra'))
    removeCustom(); assert.equal(theme.getTheme().preference, 'system')
    removeNew(); assert.equal(theme.getTheme().active.tokens['--test'], undefined)
    for (const dispose of env.disposers) dispose()
    assert.equal(notify, undefined)
    const spec = env.registrations[0].spec; const state = spec.store.spec.init()
    spec.store.spec.actions.sync(state, 'dark', 1)
    spec.store.spec.actions.sync(state, 'light', 0)
    assert.equal(state.preference, 'dark'); assert.equal(state.revision, 1)
  })
}
for (const [label, loader] of [['legacy', legacy], ['source', current]]) {
  test(`${label}: trigger controller isolates sessions, rejects stale settlements and preserves draft CAS`, async () => {
    const env = context(); const dispatched = []; const actx = {sessionId: 's', effect: effect => {const dispose = effect(); if (typeof dispose === 'function') env.disposers.push(dispose)}, bail: (_subject, name, request) => {dispatched.push({name, request}); return true}}
    loader.entry('input-trigger').apply(env.ctx)
    const service = env.ctx.inputTriggers; const calls = []; let lexiconListener; let warmed = 0
    const remove = service.registerSource({name: 'owned', trigger: '/', lexicon: () => ['a'], warm: () => {warmed++}, subscribeLexicon: (_session, listener) => {lexiconListener = listener; return () => {lexiconListener = undefined}}, candidates: (_session, request) => new Promise(resolve => {calls.push({request, resolve})}), onPick: ({candidate}) => ({text: candidate.name + ' '}), codec: {serialize: async ref => '<item>' + ref + '</item>'}})
    assert.throws(() => service.registerSource({name: 'owned', trigger: '/'}), /already registered/)
    assert.throws(() => service.sessionOf({}), /requires a session scope/)
    const controller = service.sessionOf(actx)
    assert.equal(service.sessionOf(actx), controller); assert.equal(warmed, 1)
    assert.deepEqual(normalized([...controller.lexicon.getSnapshot()]), [['/', ['a']]])
    controller.track('/a', 2, {tier: 'plain'}, 3)
    controller.track('/ab', 3, {tier: 'plain'}, 4)
    assert.equal(calls[0].request.signal.aborted, true)
    calls[0].resolve([{name: 'stale'}]); calls[1].resolve([{name: 'latest'}]); await Promise.resolve(); await Promise.resolve()
    assert.equal(controller.menu.getSnapshot().groups[0].items[0].name, 'latest')
    assert.equal(controller.arbitrate('enter', true), 'pass')
    assert.equal(controller.arbitrate('enter', false), 'pick-highlighted')
    assert.deepEqual(normalized(dispatched[0]), {name: 'slash/input-insert-text', request: {text: 'latest ', span: {start: 0, end: 3, draftRev: 4}}})
    assert.equal(controller.menu.getSnapshot().open, false)
    assert.equal(await controller.serializeReference('owned', 'a', new AbortController().signal), '<item>a</item>')
    await assert.rejects(controller.serializeReference('missing', 'a', new AbortController().signal), /no serializer/)
    controller.track('https://docs.test', 17, {tier: 'plain'}, 5)
    assert.equal(controller.menu.getSnapshot().open, false)
    controller.track('/a', 2, {tier: 'claimed'}, 6)
    assert.equal(controller.menu.getSnapshot().open, false)
    remove(); remove(); assert.equal(lexiconListener, undefined)
    assert.equal(controller.lexicon.getSnapshot().size, 0)
    for (const dispose of env.disposers) dispose()
    controller.track('/a', 2, {tier: 'plain'}, 7)
    assert.equal(controller.menu.getSnapshot().open, false)
  })
}
for (const [label, loader] of [['legacy', legacy], ['source', current]]) {
  test(`${label}: command directory folds waits and fences stale/hard-reset catalogs`, async () => {
    const {CommandDirectory} = loader.entry('commands'); const pulls = []
    const directory = new CommandDirectory(id => new Promise((resolve, reject) => pulls.push({id, resolve, reject})))
    const signal = new AbortController().signal
    const first = directory.ensureReady('s', signal); const second = directory.ensureReady('s', signal)
    assert.equal(pulls.length, 1)
    pulls[0].resolve([{name: 'first', description: 'initial'}]); await first; await second
    assert.equal(directory.resolve('s', 'first').description, 'initial')
    const old = directory.refresh('s'); const latest = directory.refresh('s')
    pulls[2].resolve([{name: 'latest', description: 'winner'}]); await latest
    pulls[1].resolve([{name: 'stale', description: 'old'}]); await old
    assert.equal(directory.resolve('s', 'latest').description, 'winner')
    directory.resetConnected()
    assert.equal(directory.resolve('s', 'latest'), undefined)
    const stop = new AbortController(); const waiting = directory.ensureReady('s', stop.signal); stop.abort()
    await assert.rejects(waiting)
    pulls[3].reject(new Error('offline')); await Promise.resolve(); await Promise.resolve()
    const retry = directory.ensureReady('s', signal); pulls[4].resolve([]); assert.deepEqual(normalized(await retry), [])
  })
  test(`${label}: command popup risk confirmation, cancelled settlements and single-flight consumption`, async () => {
    const {PopupSelectController} = loader.entry('commands'); const consumed = []; let focused = 0; let settle
    const popup = new PopupSelectController({consume: value => {consumed.push(value); return false}, focusComposer: () => {focused++}})
    const gated = {id: 'risk', label: 'Risk', confirmation: {title: 'title', description: 'desc', acknowledgeLabel: 'ack', cancelLabel: 'cancel', confirmLabel: 'go'}}
    const spec = {options: async () => [gated, {id: 'safe', label: 'Safe'}], onSelect: () => new Promise(resolve => {settle = resolve})}
    const segment = {via: 'menu', span: {start: 0, end: 2, draftRev: 9}}
    popup.open('owned', spec, {sessionId: 's'}, segment); await Promise.resolve()
    await popup.select(0); assert.equal(popup.state.getSnapshot().confirming.id, 'risk')
    await popup.confirm(); assert.equal(settle, undefined)
    popup.acknowledge(true); const pending = popup.confirm()
    assert.equal(popup.state.getSnapshot().submitting, true)
    popup.setSearch('blocked'); await popup.select(1)
    assert.equal(popup.state.getSnapshot().search, '')
    popup.dismiss(); settle(); await pending
    assert.equal(consumed.length, 0); assert.equal(focused, 0)
    popup.open('owned', {options: async () => [{id: 'safe', label: 'Safe'}], onSelect: async () => {}}, {sessionId: 's'}, segment); await Promise.resolve()
    await Promise.all([popup.select(0), popup.select(0)])
    assert.deepEqual(normalized(consumed), [segment]); assert.equal(focused, 1)
    assert.equal(popup.state.getSnapshot().open, false)
    popup.dispose()
  })
  test(`${label}: command source distinguishes inline input, host claims, image policy and contributions`, async () => {
    const env = context(); const executions = []; env.ctx.remote.commands.list = async () => ({ok: true, value: [
      {name: 'goal', description: 'Goal', input: {hint: 'objective'}}, {name: 'clear', description: 'Clear'},
      {name: 'img', description: 'Image', input: {hint: 'image', images: true}},
    ]})
    env.ctx.remote.commands.execute = async (...args) => {executions.push(args); return {ok: true, value: {result: {kind: 'success'}}}}
    loader.entry('commands').apply(env.ctx)
    const source = env.sources[0]; const session = {sessionId: 's'}; const signal = new AbortController().signal
    const candidates = await source.candidates(session, {query: '', position: 'inline', signal})
    assert.deepEqual(normalized(candidates.map(row => row.name)), ['clear'])
    assert.equal(source.matchSpace(session, '/goal').claim.token, '/goal ')
    assert.equal(source.matchSpace(session, '/clear'), undefined)
    await assert.rejects(source.matchEnter(session, '/clear', signal, {images: 1}), /imagesUnsupported/)
    assert.equal(executions.length, 0)
    const image = await source.matchEnter(session, '/img', signal, {images: 1})
    assert.equal(image.claim.images, true)
    const submit = await image.claim.submit('hello', {}, [{mediaType: 'image/png', data: 'eA=='}])
    assert.equal(submit.kind, 'success'); assert.equal(executions[0][1], '/img hello')
    const dispose = env.ctx.commandUi.register({name: 'local', description: 'Local', available: () => true, ui: {kind: 'popupSelect', options: async () => [], onSelect: () => {}}})
    assert.throws(() => env.ctx.commandUi.register({name: 'local'}), /duplicate contribution/)
    const collisionOff = env.ctx.commandUi.register({name: 'goal', description: 'Collision', available: () => true, ui: {kind: 'popupSelect', options: async () => [], onSelect: () => {}}})
    await assert.rejects(source.candidates(session, {query: '', position: 'leading', signal}), /collides/)
    collisionOff(); dispose()
    assert.equal((await source.candidates(session, {query: '', position: 'leading', signal})).length, 3)
  })
}
for (const [label, loader] of [['legacy', legacy], ['source', current]]) {
  test(`${label}: settings mirror serializes invalidations and scopes fence rapid writes/recovery`, async () => {
    const env = context(); const wire = env.ctx.get('connection').api; const reads = []; const writes = []
    wire.settings.describe = () => new Promise(resolve => reads.push(resolve))
    wire.settings.mutate = input => new Promise(resolve => writes.push({input, resolve}))
    loader.entry('settings').apply(env.ctx); const mirror = env.ctx.settingsScope.describe()
    await Promise.resolve(); assert.equal(reads.length, 1)
    const row = {ns: 'owned', value: {selection: 'first'}, base: {}, user: {}, revision: 1, schema: {type: 'object', meta: {}, dict: {selection: {type: 'string', meta: {}}}}}
    reads[0]({result: {ok: true, value: {namespaces: [row], writable: true, hasDocument: true}}}); await mirror.ensure()
    const scope = env.ctx.settingsScope.bind({namespace: 'owned', decode: section => typeof section?.selection === 'string' ? section : undefined})
    assert.equal(scope.getSnapshot().value.selection, 'first')
    const first = scope.set('selection', 'one'); const second = scope.set('selection', 'two'); await Promise.resolve()
    assert.equal(writes.length, 1); assert.equal(writes[0].input.expectedRevision, 1)
    writes[0].resolve({result: {ok: true, value: {...row, revision: 2, value: {selection: 'one'}}}}); await first; await Promise.resolve()
    assert.equal(writes[1].input.expectedRevision, 2); assert.equal(scope.getSnapshot().value.selection, 'first')
    writes[1].resolve({result: {ok: true, value: {...row, revision: 3, value: {selection: 'two'}}}}); await second
    assert.equal(scope.getSnapshot().value.selection, 'two')
    const failure = scope.unset('selection'); await Promise.resolve()
    writes[2].resolve({result: {ok: false, error: {code: 'conflict', message: 'CAS'}}}); await new Promise(resolve => setImmediate(resolve))
    assert.equal(reads.length, 2)
    reads[1]({result: {ok: true, value: {namespaces: [{...row, revision: 4, value: {selection: 'authoritative'}}], writable: true, hasDocument: true}}}); await failure
    assert.equal(scope.getSnapshot().value.selection, 'authoritative')
    const schema = env.ctx.settingsSchema
    assert.equal(schema.validate(schema.rehydrate(row.schema), {selection: 'valid'}), undefined)
    assert.match(schema.validate(schema.rehydrate(row.schema), {selection: 7}), /string/)
    const draft = {nested: [{name: 'before'}]}; const changed = schema.setPath(draft, ['nested', '0', 'name'], 'after')
    assert.equal(draft.nested[0].name, 'before'); assert.equal(schema.getPath(changed, ['nested', '0', 'name']), 'after')
    assert.equal(schema.hasPath(changed, ['nested', '0', 'name']), true)
    assert.equal(schema.deletePath(changed, ['absent']), changed)
    assert.throws(() => schema.setPath(draft, [], 1), /non-empty/)
    const node = schema.nodeAtPath(schema.rehydrate(row.schema), ['selection']); assert.equal(node.type, 'string')
    const disposers = [...env.disposers]; for (const dispose of disposers) await dispose()
    const writeCount = writes.length; await scope.set('selection', 'ignored'); assert.equal(writes.length, writeCount)
  })
  test(`${label}: non-loopback settings stay unavailable and issue no transport reads or writes`, async () => {
    const env = context(); const connection = env.ctx.get('connection'); connection.isLoopback = false
    let calls = 0; connection.api.settings.describe = () => {calls++; throw new Error('should not read')}
    connection.api.settings.mutate = () => {calls++; throw new Error('should not mutate')}
    loader.entry('settings').apply(env.ctx)
    const mirror = env.ctx.settingsScope.describe(); await mirror.ensure()
    assert.equal(mirror.getSnapshot().status, 'unavailable')
    const scope = env.ctx.settingsScope.bind({namespace: 'owned'}); assert.equal(scope.getSnapshot().mode, 'memory')
    await scope.set('selection', 'new'); assert.equal(calls, 0)
  })
}
for (const [label, loader] of [['legacy', legacy], ['source', current]]) {
  test(`${label}: settings shell ledger selectors preserve localization cache and subscription teardown`, () => {
    const env = context(); let version = 0; let revision = 0; let offLedger = 0; let offLocale = 0
    env.ctx.slots.getVersion = () => version
    env.ctx.slots.entries = name => name === 'settings.section' ? [{options: {id: 'late', order: 9, label: () => `Locale ${revision}`}}, {options: {id: 'early', order: 1, label: 'First'}}] : []
    env.ctx.locale.getSnapshot = () => ({revision})
    env.ctx.slots.subscribe = () => () => {offLedger++}; env.ctx.locale.subscribe = () => () => {offLocale++}
    loader.entry('settings-general').apply(env.ctx)
    const root = env.registrations.find(entry => entry.spec.name === 'sidebar.settings')
    const face = root.spec.inject(); const before = face.hooks.sections.getSnapshot()
    assert.deepEqual(normalized(before.map(row => row.id)), ['early', 'late'])
    assert.equal(face.hooks.sections.getSnapshot(), before)
    revision++
    const after = face.hooks.sections.getSnapshot(); assert.notEqual(after, before); assert.equal(after[1].label, 'Locale 1')
    const off = face.hooks.sections.subscribe(() => {}); off(); assert.equal(offLedger, 1); assert.equal(offLocale, 1)
    version++
    assert.notEqual(face.hooks.sections.getSnapshot(), after)
  })
  test(`${label}: settings local document action single-flight native open and disposal remain stable`, async () => {
    const env = context(); let wireResolve; let calls = 0; let mirrorOff = 0
    env.ctx.get('connection').api.settings.openDocument = () => {calls++; return new Promise(resolve => {wireResolve = resolve})}
    env.ctx.settingsScope.describe = () => ({getSnapshot: () => ({status: 'ready', view: {hasDocument: true}, error: null}), subscribe: () => () => {mirrorOff++}, ensure: async () => {}})
    loader.entry('settings-general').apply(env.ctx)
    const action = env.registrations.find(entry => entry.spec.name === 'settings.action'); const controller = action.spec.inject().controller
    await controller.load(); assert.equal(controller.store.getSnapshot().status, 'ready')
    const first = controller.open(); await controller.open(); assert.equal(calls, 1)
    assert.equal(controller.store.getSnapshot().opening, true)
    wireResolve({result: {ok: false, error: {message: 'not available'}}}); await first
    assert.equal(controller.store.getSnapshot().opening, false); assert.equal(controller.store.getSnapshot().error, 'not available')
    for (const dispose of env.disposers) dispose(); assert.equal(mirrorOff, 1)
  })
}

function componentStateHarness(loader, component, props) {
  const original = {...loader.react}; const states = []; const effectStates = []; let cursor = 0; let effectCursor = 0; let pending = []
  loader.react.useState = initial => {const index = cursor++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial; return [states[index], value => {states[index] = typeof value === 'function' ? value(states[index]) : value}]}
  loader.react.useEffect = (callback, deps) => {const index = effectCursor++; const previous = effectStates[index]; if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {pending.push(() => {previous?.dispose?.(); effectStates[index] = {deps, dispose: callback()}})}}
  return {
    render() {cursor = 0; effectCursor = 0; const element = component(props); const effects = pending; pending = []; for (const effect of effects) effect(); return element},
    dispose() {for (const effect of effectStates) effect?.dispose?.(); Object.assign(loader.react, original)},
  }
}
function elements(root, predicate) {
  const found = []
  function visit(node) {if (Array.isArray(node)) {node.forEach(visit); return} if (!node || typeof node !== 'object') return; if (predicate(node)) found.push(node); visit(node.props?.children)}
  visit(root); return found
}
for (const [label, loader] of [['legacy', legacy], ['source', current]]) {
  test(`${label}: read-only plugin inventory fetch/filter/expand/retry and late disposal`, async () => {
    const env = context(); const requests = []
    env.ctx.remote.pluginInventory.list = () => new Promise(resolve => requests.push(resolve))
    loader.entry('settings-plugin-inventory').apply(env.ctx)
    const registration = env.registrations[0]; const props = {...registration.spec.inject(), t: key => key}
    const hooks = componentStateHarness(loader, registration.component, props)
    try {
      let tree = hooks.render(); assert.equal(tree.props['aria-busy'], true)
      await Promise.resolve(); assert.equal(requests.length, 1)
      requests[0]({ok: true, value: {entries: [
        {entryId: 'first/id', moduleName: '@xharness/dsh-client-theme', enabled: true, fiberPhase: 'active'},
        {entryId: 'second', moduleName: 'cordis-plugin-shell', enabled: false, fiberPhase: null},
      ]}}); await new Promise(resolve => setImmediate(resolve))
      tree = hooks.render(); assert.equal(tree.props['aria-busy'], false)
      assert.equal(elements(tree, node => node.type === 'li').length, 2)
      const button = elements(tree, node => node.type === 'button')[0]; button.props.onClick()
      tree = hooks.render(); assert.equal(elements(tree, node => node.props?.['data-loader-entry'] !== undefined)[0].props.children, 'first/id')
      const input = elements(tree, node => node.type === 'input')[0]; input.props.onChange({currentTarget: {value: 'SHELL'}})
      tree = hooks.render(); assert.equal(elements(tree, node => node.type === 'li').length, 1)
      assert.equal(elements(tree, node => node.props?.['data-loader-entry'] !== undefined).length, 0)
      assert.equal(elements(tree, node => node.props?.['data-phase'] !== undefined).length, 0)
      input.props.onChange({currentTarget: {value: 'missing'}}); tree = hooks.render()
      assert.equal(elements(tree, node => node.type === 'p')[0].props.children, 'emptySearch')
    } finally {hooks.dispose()}
    const errorHooks = componentStateHarness(loader, registration.component, props)
    try {
      errorHooks.render(); await Promise.resolve(); requests[1]({ok: false, error: {code: 'down', message: 'offline'}})
      await new Promise(resolve => setImmediate(resolve)); let tree = errorHooks.render()
      assert.equal(elements(tree, node => node.props?.role === 'alert').length, 1)
      elements(tree, node => node.type === 'button')[0].props.onClick(); tree = errorHooks.render()
      assert.equal(tree.props['aria-busy'], true); await Promise.resolve(); assert.equal(requests.length, 3)
      errorHooks.dispose(); requests[2]({ok: true, value: {entries: []}}); await new Promise(resolve => setImmediate(resolve))
    } finally {errorHooks.dispose()}
  })
}
function pluginScope(initial) {
  let state = {status: 'ready', value: {...initial}, base: {...initial}, user: {}, revision: 1, writable: true, mode: 'host'}
  const listeners = new Set(); const writes = []
  const publish = () => {for (const listener of listeners) listener()}
  return {
    scope: {getSnapshot: () => state, subscribe: listener => {listeners.add(listener); return () => listeners.delete(listener)}, set: (field, value) => new Promise(resolve => writes.push({field, value, clear: false, resolve})), unset: field => new Promise(resolve => writes.push({field, clear: true, resolve}))},
    writes,
    change(next) {state = {...state, ...next}; publish()},
    settle(index, accepted) {const write = writes[index]; if (accepted) {const user = {...state.user}; if (write.clear) delete user[write.field]; else user[write.field] = write.value; state = {...state, user, value: {...state.base, ...user}, revision: state.revision + 1}; publish()} write.resolve()},
  }
}
for (const [label, loader] of [['legacy', legacy], ['source', current]]) {
  test(`${label}: plugin card staged drafts, invalid-save guard, ordered single flight and failed readback`, async () => {
    const env = context(); const shell = pluginScope({timeoutMs: 10, maxOutputBytes: 20})
    shell.change({user: {timeoutMs: 10}})
    env.ctx.settingsScope.bind = spec => spec.namespace === 'shell' ? shell.scope : pluginScope({}).scope
    loader.entry('settings-plugins').apply(env.ctx)
    const face = env.registrations.find(entry => entry.spec.key === 'shell').spec.inject()
    const snapshot = () => face.hooks.bashCard.getSnapshot()
    assert.equal(snapshot().timeoutMs.overridden, true); assert.equal(snapshot().dirty, false)
    face.edit('timeoutMs', 'NaN'); assert.equal(snapshot().invalid, true); face.save()
    assert.equal(shell.writes.length, 0)
    face.discard(); assert.equal(snapshot().timeoutMs.text, '10')
    face.edit('timeoutMs', '100'); face.edit('maxOutputBytes', '200'); face.save(); face.save()
    assert.equal(snapshot().saving, true); assert.equal(shell.writes.length, 1)
    shell.settle(0, true); await new Promise(resolve => setImmediate(resolve)); assert.equal(shell.writes.length, 2)
    shell.settle(1, false); await new Promise(resolve => setImmediate(resolve))
    assert.equal(snapshot().failed, true); assert.equal(snapshot().maxOutputBytes.text, '200'); assert.equal(snapshot().dirty, true)
    face.save(); assert.equal(shell.writes.length, 3); assert.equal(shell.writes[2].field, 'maxOutputBytes')
    shell.settle(2, true); await new Promise(resolve => setImmediate(resolve)); assert.equal(snapshot().failed, false); assert.equal(snapshot().dirty, false)
    face.resetField('timeoutMs'); assert.equal(snapshot().timeoutMs.text, '10'); assert.equal(snapshot().timeoutMs.overridden, false)
    face.save(); shell.settle(3, true); await new Promise(resolve => setImmediate(resolve)); assert.equal(snapshot().dirty, false)
    assert.equal(shell.scope.getSnapshot().value.timeoutMs, 10); assert.equal(Object.hasOwn(shell.scope.getSnapshot().user, 'timeoutMs'), false)
    assert.throws(() => face.resetField('missing'), /no field/)
  })
  test(`${label}: plugin directory intersects served/registered namespaces with stable snapshots and cleanup`, () => {
    const env = context(); let described = {status: 'loading', view: undefined, error: null}; let mirrorListener; let mirrorOff = 0
    let entries = [{options: {key: 'shell'}}, {options: {key: 'missing'}}, {options: {key: 'agent-loop'}}]
    env.ctx.settingsScope.describe = () => ({getSnapshot: () => described, subscribe: listener => {mirrorListener = listener; return () => {mirrorOff++}}, ensure: async () => {}})
    env.ctx.slots.entries = name => name === 'settings.plugin.item' ? entries : []
    let cardLedgerListener; env.ctx.slots.subscribe = (name, listener) => {if (name === 'settings.plugin.item') cardLedgerListener = listener; return () => {}}
    loader.entry('settings-plugins').apply(env.ctx)
    assert.equal(env.registrations.some(entry => entry.spec.name === 'settings.section'), false)
    assert.equal(env.registrations[0].spec.name, 'plugins.advanced')
    const tab = env.registrations.find(entry => entry.spec.id === 'configurable').spec.inject().hooks.configurablePlugins
    assert.equal(tab.getSnapshot().loaded, false)
    described = {status: 'ready', view: {namespaces: [{ns: 'agent-loop'}, {ns: 'unregistered'}, {ns: 'shell'}]}, error: null}; mirrorListener()
    assert.deepEqual(normalized(tab.getSnapshot().namespaces), ['shell', 'agent-loop'])
    const previous = tab.getSnapshot(); mirrorListener(); assert.equal(tab.getSnapshot(), previous)
    entries = [...entries, {options: {key: 'unregistered'}}]; cardLedgerListener()
    assert.deepEqual(normalized(tab.getSnapshot().namespaces), ['shell', 'agent-loop', 'unregistered'])
    env.disposers.forEach(dispose => dispose()); assert.equal(mirrorOff, 1)
    const final = tab.getSnapshot(); described = {status: 'ready', view: {namespaces: []}, error: null}; mirrorListener(); assert.equal(tab.getSnapshot(), final)
  })
  test(`${label}: plugin credential reference changes reject stale answers, refresh only addressed ref and stage secret`, async () => {
    const env = context(); const web = pluginScope({apiKeyEnv: 'REF_A', maxUses: 2}); const reads = []; const keys = []
    env.ctx.settingsScope.bind = spec => spec.namespace === 'web-search-deepseek' ? web.scope : pluginScope({}).scope
    env.ctx.get('connection').api.credentials.describe = request => new Promise(resolve => reads.push({request, resolve}))
    env.ctx.get('connection').api.credentials.set = async request => {keys.push(request); return {result: {ok: true, value: null}}}
    loader.entry('settings-plugins').apply(env.ctx)
    const face = env.registrations.find(entry => entry.spec.key === 'web-search-deepseek').spec.inject()
    const snapshot = () => face.hooks.webSearchCard.getSnapshot()
    assert.deepEqual(normalized(reads[0].request.refs), ['REF_A']); assert.equal(snapshot().apiKey.text, '')
    web.change({value: {apiKeyEnv: 'REF_B'}}); assert.deepEqual(normalized(reads[1].request.refs), ['REF_B'])
    reads[0].resolve({result: {ok: true, value: {credentials: {REF_A: {configured: true, writable: false}}}}}); await new Promise(resolve => setImmediate(resolve))
    assert.equal(snapshot().apiKeyConfigured, false); assert.equal(snapshot().apiKeyWritable, true)
    reads[1].resolve({result: {ok: true, value: {credentials: {REF_B: {configured: false, writable: true}}}}}); await new Promise(resolve => setImmediate(resolve))
    env.listeners.get('credentials/updated')('REF_A'); assert.equal(reads.length, 2)
    face.edit('apiKey', '   '); assert.equal(snapshot().dirty, false); face.save(); assert.equal(keys.length, 0)
    face.edit('apiKey', 'test-only-key'); face.save(); face.save(); assert.equal(keys.length, 1)
    await new Promise(resolve => setImmediate(resolve)); assert.equal(reads.length, 3)
    reads[2].resolve({result: {ok: true, value: {credentials: {REF_B: {configured: true, writable: true}}}}}); await new Promise(resolve => setImmediate(resolve))
    assert.equal(snapshot().apiKey.text, ''); assert.equal(snapshot().apiKeyConfigured, true); assert.equal(snapshot().dirty, false)
    assert.equal(keys[0].ref, 'REF_B'); assert.equal(keys[0].value, 'test-only-key')
    env.listeners.get('credentials/updated')('REF_B'); assert.equal(reads.length, 4)
    reads[3].resolve({result: {ok: true, value: {credentials: {REF_B: {configured: true, writable: false}}}}}); await new Promise(resolve => setImmediate(resolve))
    assert.equal(snapshot().apiKeyWritable, false)
  })
}

test('source: root frame retains current-master workspace.item root-list declaration',()=>{const env=context();current.entry('layout').apply(env.ctx);assert.deepEqual(normalized(env.registrations[0].spec.children['workspace.item']),{kind:'list',scope:'root'})})
