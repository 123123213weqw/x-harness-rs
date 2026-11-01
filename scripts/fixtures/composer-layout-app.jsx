// Isolated layout fixture: production components and input machine, synthetic
// projections only. No Host connection, model request, filesystem or user data.
import React, { useSyncExternalStore } from 'react'
import { createRoot, flushSync } from 'react-dom'
import { ConversationRoot } from '../../ui/src/modules/conversation/skeleton/ConversationRoot'
import { XHarnessEditableInputBar } from '../../ui/src/modules/conversation/edit/EditableInputBar'
import { SessionInputShell } from '../../ui/src/modules/conversation/input/facade'
import { StatsLine } from '../../ui/src/modules/conversation/chat/StatsLine'
import { TodoDock } from '../../ui/src/modules/conversation/skeleton/TodoPanel'
import { ProgressDock } from '../../ui/src/modules/goal/ProgressDock'
import { QueueDock } from '../../ui/src/modules/conversation/queue/QueueDock'
import { EnvironmentPicker } from '../../ui/src/modules/runtime-environment/EnvironmentPicker'
import { en as environmentEn } from '../../ui/src/modules/runtime-environment/locales'
import { GoalDock } from '../../ui/src/modules/goal/GoalBar'
import { XHarnessModelSelect } from '../../ui/src/modules/model-selection/ModelSelect'
import { en as conversationEn, zh as conversationZh } from '../../ui/src/modules/conversation/locales'
import { en as modelEn } from '../../ui/src/modules/model-selection/locales'
import { en as goalEn } from '../../ui/src/modules/goal/locales'
import theme from '../../ui/src/modules/theme/design-platform.css'
import monochrome from '../../ui/overrides/monochrome.css'
const style = document.createElement('style')
style.textContent = theme + '\n' + monochrome
document.head.appendChild(style)
const store = initial => {
  let value = initial
  const listeners = new Set()
  return { getSnapshot: () => value, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) },
    set: next => { value = next; for (const fn of listeners) fn() } }
}
const hook = state => select => select(useSyncExternalStore(state.subscribe, state.getSnapshot))
const translate = dictionary => (key, args) => Object.entries(args ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), dictionary[key] ?? key)
const t = translate(conversationEn), modelT = translate(modelEn), goalT = translate(goalEn)
const language = store('en')
const query = new URLSearchParams(location.search)
const polished = query.has('polish')
const hero = query.has('hero')
const calls = []
const snapshot = store({openState:'open', composerPhase:hero?'blank':'active', running:!hero, removed:false, promptError:null, subagent:null, queue:polished&&!hero?[{id:'preview-queue',placement:'queued',text:'continue',preview:'continue'}]:[], pending:[], chat:{legacy:{nodes:[]}}})
const sessions = store({byId:{fixture:{cwd:'/isolated-preview',blank:hero}}})
const workspaces = store({items:[{workspaceId:'fixture',title:'Preview',sessionIds:['fixture']}],phase:'ready'})
const goal = { id:'preview-goal', revision:1, objective:'Improve the parser and verify the regression tests', phase:'paused', maxGoalRounds:256 }
const projection = store({
  taskPlan:polished&&!hero?{revision:1,items:[{id:'review',title:'Review existing server',status:'completed'},{id:'routing',title:'Implement request routing',status:'in_progress'},{id:'tests',title:'Run load tests',status:'pending'}]}:null,
  goal:query.has('minimal')||hero?null:{goal,roundsStarted:257,execution:{state:'paused',enabled:true,roundsStarted:257,maxGoalRounds:256}},
  sessionStats:{turns:185,steps:2446,llmMs:174192000,toolMs:31562000,ttftMs:40600,ttftSteps:1,decodeTokens:4400,decodeMs:100000},
  tokenUsage:{uncachedInputTokens:75000000,cacheReadTokens:6100000000,cacheWriteTokens:0,outputTokens:18000000},
  contextPressure:{pressureTokens:65000,contextWindow:262144},
  permissions:{currentValue:'danger-full-access',activeValue:'danger-full-access',pending:false,options:[{value:'workspace-write',name:'workspace-write'},{value:'danger-full-access',name:'full-access'}]},
})
const directory = store({status:'ready',current:{provider:'fixture',model:'qwen',contextWindowTokens:262144},groups:[{id:'fixture',name:'Preview',models:[{id:'qwen',name:'qwen3.8-27b-uncensored',contextWindow:262144,reasoning:{efforts:[{id:'high',name:'High'},{id:'max',name:'Maximum'}]}}]}],failures:[],routable:true,error:null})
const shell = new SessionInputShell({actx:{},defaultSink:async(text,images,mode)=>{calls.push({send:text,images,mode});return {kind:'success'}},commandImages:{serialize:async()=>[],release:()=>{},unsupportedNotice:()=>''}})
const useSession = hook(snapshot), useInput = hook(shell.state)
const useProjection = (key, select) => { const values=useSyncExternalStore(projection.subscribe,projection.getSnapshot); return select ? select(values[key]) : values[key] }
const goalAction = name => async value => { calls.push({goal:name,value}); return {ok:true,value:{}} }
const goalProps = {useProjection,onComplete:goalAction('complete'),onResume:goalAction('resume'),onPause:goalAction('pause'),onClear:goalAction('clear'),onEdit:goalAction('edit'),t:goalT}
const loadModels = async () => {}
const selectModel = async value => { calls.push({model:value});directory.set({...directory.getSnapshot(),current:value});return true }
const updateQueue = async (id,action) => {
  calls.push({queue:id,action})
  const current=snapshot.getSnapshot()
  const queue=action.kind==='edit'
    ?current.queue.map(row=>row.id===id?{...row,text:action.content[0].text,preview:action.content[0].text}:row)
    :current.queue.filter(row=>row.id!==id)
  snapshot.set({...current,queue})
}
const slot = (name,children) => <div data-slot={name} style={{display:'contents'}}>{children}</div>
const inputProps = {sessionId:'fixture',useSession,useInput,inputActions:shell.actions,keyboard:shell,
  addImages:files=>{calls.push({attachments:files.map(file=>file.name)});return null},draftImages:()=>[],
  resolveSubmitMode:()=> 'queue',toggleCommandMenu:()=>calls.push({commands:true}),stop:()=>calls.push({stop:true}),command:async line=>{calls.push({command:line});return true},
  useNotices:hook(shell.notices),useLexicon:hook(shell.lexicon),useMenuLauncher:()=>false,useProjection,t,
  renderSlot:(key,owner)=>slot(key,key==='conversation.input.model'?<XHarnessModelSelect compact={owner.compact} locked={owner.locked} available directory={directory} load={loadModels} select={selectModel} t={modelT}/>:null)}
const root = createRoot(document.getElementById('root'))
function App() {
  const locale = useSyncExternalStore(language.subscribe, language.getSnapshot)
  const t = translate(locale === 'zh' ? conversationZh : conversationEn)
  const state = useSession(value=>value)
  return <ConversationRoot sessionId="fixture" useSession={useSession} useInput={useInput} useSessions={hook(sessions)} useWorkspaces={hook(workspaces)} useComposerBlock={()=>undefined} selectWorkspace={async()=>{}} t={t}
    renderSlotChain={(_name,_owner,options)=>options.fallback}
    renderSlot={(key,owner)=>slot(key,key==='conversation.composer.bar'?<XHarnessEditableInputBar {...inputProps} {...owner}/>:
      key==='conversation.input.dock'?<><TodoDock useProjection={useProjection} t={t}/><ProgressDock useProjection={useProjection} t={goalT}/><GoalDock {...goalProps}/><QueueDock useSession={useSession} updateQueue={updateQueue} notify={(level,text)=>calls.push({level,text})} t={t}/></>:
      key==='conversation.hero.runtimeEnvironment'?<EnvironmentPicker {...owner} t={translate(environmentEn)}/>:
      key==='conversation.composer.dock'?<StatsLine useSession={useSession} useProjection={useProjection} t={t}/>:
      key==='conversation.session'&&state.composerPhase==='active'?<section className="preview-transcript"><div className="preview-avatar">X</div><div><h1>A clearer place to work</h1><p>Goal, message controls and conversation metrics now share one composer.</p><p>Try the model menu, draft a message or expand the metrics. This is an isolated preview; nothing is sent.</p></div></section>:null)}/>
}
const render = () => flushSync(()=>root.render(<App/>))
window.__composerFixture = { calls, shell, snapshot, projection, directory, render,
  set: changes => flushSync(()=>{
    if ('locale' in changes) language.set(changes.locale)
    if('running' in changes || 'hero' in changes || 'removed' in changes || 'subagent' in changes) snapshot.set({...snapshot.getSnapshot(),...('running' in changes?{running:changes.running}:{}),...('removed' in changes?{removed:changes.removed}:{}),...('subagent' in changes?{subagent:changes.subagent}:{}),...('hero' in changes?{composerPhase:changes.hero?'blank':'active'}:{})})
    if('goal' in changes) projection.set({...projection.getSnapshot(),goal:changes.goal?{goal,roundsStarted:257,execution:{state:'paused',enabled:true,roundsStarted:257,maxGoalRounds:256}}:null})
    if('hero' in changes)sessions.set({...sessions.getSnapshot(),byId:{fixture:{...sessions.getSnapshot().byId.fixture,blank:changes.hero}}})
    if('queue' in changes)snapshot.set({...snapshot.getSnapshot(),queue:changes.queue})
    if('taskPlan' in changes) projection.set({...projection.getSnapshot(),taskPlan:changes.taskPlan})
    if('todos' in changes) projection.set({...projection.getSnapshot(),todos:changes.todos})
    if('stats' in changes) projection.set({...projection.getSnapshot(),sessionStats:changes.stats?{turns:185,steps:2446,llmMs:174192000,toolMs:31562000,ttftMs:40600,ttftSteps:1,decodeTokens:4400,decodeMs:100000}:undefined,tokenUsage:changes.stats?{uncachedInputTokens:75000000,cacheReadTokens:6100000000,cacheWriteTokens:0,outputTokens:18000000}:undefined})
    if('longName' in changes) directory.set({...directory.getSnapshot(),groups:[{...directory.getSnapshot().groups[0],models:[{...directory.getSnapshot().groups[0].models[0],name:changes.longName}]}]})
    if('dark' in changes) document.body.toggleAttribute('data-ds-dark-theme',changes.dark)
  }) }
if(query.has('dark'))document.body.setAttribute('data-ds-dark-theme','')
render()
