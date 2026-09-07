import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { patchConversationMessageEdit } from './patch-conversation-message-edit.mjs'

const bundleUrl = new URL('../ui/dist/plugins/@deepseek-ai/dsh-client-ui-conversation/client.js', import.meta.url)
const bundle = readFileSync(bundleUrl)
const text = bundle.toString('utf8')
assert.equal(
  patchConversationMessageEdit(bundle).toString(),
  text,
  'packaged message editor must match product source; patch is idempotent',
)
assert.throws(() => patchConversationMessageEdit(Buffer.from('changed upstream bundle')), /signature changed/)
new vm.Script(text, { filename: 'conversation/client.js' })

for (const expected of [
  'data-message-edit',
  'editAvailable: !running',
  'message.edit": "编辑并重新发送',
  'message.edit": "Edit and resend',
  'editMessage: (text) => xhEditMessage(inputHub, sessionId, text)',
]) assert.ok(text.includes(expected), `missing packaged message-editor behavior: ${expected}`)

const override = readFileSync(new URL('../ui/overrides/conversation-message-edit.js', import.meta.url), 'utf8')
const helper = override.match(/function xhEditMessage[\s\S]*?(?=\n\t\tfunction XHarnessEditIcon)/)?.[0]
assert.ok(helper, 'message editor helper must remain independently testable')
const sandbox = { result: undefined }
vm.runInNewContext(`${helper}\nresult = xhEditMessage`, sandbox)

let draft
const inputHub = { shell: id => {
  assert.equal(id, 'session-test')
  return { setDraft: value => { draft = value } }
} }
const calls = []
const textarea = {
  focus: () => calls.push('focus'),
  setSelectionRange: (start, end) => calls.push(['selection', start, end]),
  scrollIntoView: options => calls.push(['scroll', options.block]),
}
const root = { querySelector: selector => {
  assert.equal(selector, '[data-composer-seat] textarea')
  return textarea
} }
const frames = []
sandbox.requestAnimationFrame = callback => frames.push(callback)
sandbox.result(inputHub, 'session-test', '修改这句话', root)
assert.equal(draft, '修改这句话')
assert.deepEqual(calls, [], 'focus waits until React has committed the controlled draft')
assert.equal(frames.length, 1)
frames[0]()
assert.equal(calls[0], 'focus')
assert.deepEqual(calls[1], ['selection', 5, 5])
assert.deepEqual(calls[2], ['scroll', 'nearest'])

const graph = JSON.parse(readFileSync(new URL('../ui/dist/client-graph.json', import.meta.url), 'utf8'))
const html = readFileSync(new URL('../ui/dist/index.html', import.meta.url), 'utf8')
assert.deepEqual(JSON.parse(html.match(/window\.__DSH_BOOT__ = (.*?)<\/script>/)[1]), graph)
const entry = graph.entries.find(candidate => candidate.id === '@deepseek-ai/dsh-client-ui-conversation')
assert.equal(entry.rev, createHash('sha256').update(bundle).digest('hex').slice(0, 16))
assert.ok(!text.includes('sourceMappingURL=client.js.map'))

console.log('paused user-message editing, composer focus, localization, idempotence, and boot hash passed')
