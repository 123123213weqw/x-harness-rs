// Real emitted Session and ChatView: an async worker failure must be visible,
// not an invented turn success or an automatic replay.
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {readFileSync} from 'node:fs'
import {compile,harness} from './conversation-test-harness.mjs'
import {testHooks,descendants} from './conversation-test-hooks.mjs'
import {terminalHarness} from './session-terminal-test-harness.mjs'

const compiled = compile()
const hooks = testHooks()
const {plugin,context} = harness(compiled.test,hooks)
context.document.documentElement = {dataset:{}}
const {session} = terminalHarness(compiled.test)

function render(snapshot,language='en') {
  hooks.reset()
  const dictionary = plugin[language]
  const t = (key,args={}) => (dictionary[key] ?? key).replace(/\{(\w+)\}/g,(_,name)=>args[name])
  return hooks.render(()=>plugin.ChatView({
    sessionId:snapshot.sessionId, useSession:select=>select(snapshot),
    useSessions:select=>select({byId:{}}),useStore:select=>select({}),
    renderSlot:()=>null,chatScroll:{read:()=>null,save:()=>{}},t,
  }))
}

test('background failure reaches the real Session snapshot and persistent accessible chat alert',()=>{
  const active = session()
  active.handleRunning(true)
  const before = active.getSnapshot()
  assert.equal(descendants(render(before),n=>n.props?.['data-agent-error']!==undefined).length,0)
  const message = 'Conversation worker stopped; outcome unknown. <script>not markup</script>'
  active.handleAgentError(message)
  const after = active.getSnapshot()
  assert.equal(after.lastAgentError,message)
  assert.equal(after.running,true,'no fake idle or successful terminal state')
  assert.equal(after.chat,before.chat,'no fabricated message or turn/end')
  for(const language of ['en','zh']) {
    const tree = render(after,language)
    const notices = descendants(tree,n=>n.props?.['data-agent-error']!==undefined)
    assert.equal(notices.length,1)
    assert.equal(notices[0].props.role,'alert')
    assert.ok(tree.props.children.includes(notices[0]),'error stays outside the long transcript scrollport')
    assert.equal(typeof notices[0].props.children,'string','React text, never injected HTML')
    assert.ok(notices[0].props.children.includes(message))
    assert.equal(notices[0].props.dangerouslySetInnerHTML,undefined)
    assert.equal(descendants(notices[0],n=>n.type==='button').length,0,'unknown outcomes must not auto-retry')
  }
  assert.equal(descendants(render(active.getSnapshot()),n=>n.props?.['data-agent-error']!==undefined).length,1,'ordinary rerenders retain the alert')
})

test('shipped conversation entry includes the actual failure outlet',()=>{
  const shipped = readFileSync(new URL('../ui/dist/plugins/@xharness/dsh-client-ui-conversation/client.js',import.meta.url),'utf8')
  assert.equal(shipped,compiled.entry,'source must be rebuilt into the shipped product')
  assert.ok(shipped.includes('data-agent-error'))
})


test('failure notice also remains visible under the production outer conversation scroller',()=>{
  const css = readFileSync(new URL('../ui/src/modules/conversation/chat/ChatView.css',import.meta.url),'utf8')
  const rule = css.match(/\.IxU-fW_openError\[data-agent-error\]\{([^}]+)\}/)?.[1]
  assert.ok(rule,'dedicated failure notice styling')
  assert.match(rule,/position:sticky/)
  assert.match(rule,/top:0(?:;|$)/)
  assert.match(rule,/background:/,'sticky text must not overlap transcript without a surface')
})
