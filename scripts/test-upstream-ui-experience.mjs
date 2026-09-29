import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'
import { patchToolExperience, patchConversationExperience, patchModelSwitchProgress } from './patch-upstream-ui-experience.mjs'

const root = resolve(new URL('..', import.meta.url).pathname)
const graph = JSON.parse(readFileSync(resolve(root, 'ui/dist/client-graph.json'), 'utf8'))
const html = readFileSync(resolve(root, 'ui/dist/index.html'), 'utf8')
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16)
for (const [id, patch] of [
  ['@xharness/dsh-client-ui-tool', patchToolExperience],
  ['@xharness/dsh-client-ui-conversation', patchConversationExperience],
  ['@xharness/dsh-client-ui-model-selection', patchModelSwitchProgress],
]) {
  const code = readFileSync(resolve(root, `ui/dist/plugins/${id}/client.js`))
  assert.deepEqual(patch(code), code, `${id} patch must be idempotent`)
  const entry = graph.entries.find(value => value.id === id)
  assert.equal(entry.rev, hash(code), `${id} graph revision`)
  assert.match(code.toString(), /XHARNESS UPSTREAM UI EXPERIENCE 0\.1\.7-rc\.2/)
}
const productId = '@xlang/xharness-client-ui-experience'
const product = readFileSync(resolve(root, `ui/plugins/${productId}/client.js`))
const shipped = readFileSync(resolve(root, `ui/dist/plugins/${productId}/client.js`))
assert.deepEqual(shipped, product)
assert.equal(graph.entries.find(value => value.id === productId)?.rev, hash(product))
assert.ok(graph.entries.indexOf(graph.entries.find(value => value.id === productId)) > graph.entries.indexOf(graph.entries.find(value => value.id === '@xharness/dsh-client-ui-settings')))
assert.match(html, /@xlang\/xharness-client-ui-experience/)
assert.match(html, new RegExp(`"rev":"${graph.rev}"`))
const tool = readFileSync(resolve(root, 'ui/dist/plugins/@xharness/dsh-client-ui-tool/client.js'), 'utf8')
assert.equal((tool.match(/XHReviewDiffBlock, \{/g) ?? []).length, 2, 'tool row and details share review surface')
assert.match(tool, /target: "_blank", rel: "noopener noreferrer"/)
assert.match(tool, /data-state|"preparing"/)
const css = readFileSync(resolve(root, 'ui/dist/monochrome.css'), 'utf8')
assert.match(css, /xh-model-switching/)
assert.match(css, /prefers-reduced-motion/)
const conversation = readFileSync(resolve(root, 'ui/dist/plugins/@xharness/dsh-client-ui-conversation/client.js'), 'utf8')
const start = conversation.indexOf('function xhPreparingCall(')
const end = conversation.indexOf('\n\t\t}', start)
assert.ok(start > 0 && end > start, 'streaming preparation predicate exists')
const preparing = vm.runInNewContext(`${conversation.slice(start, end + 4)}; xhPreparingCall`)
assert.equal(preparing({ kind: 'tool-call', name: 'bash', argsRaw: '{"command":' }), true)
assert.equal(preparing({ kind: 'tool-call', name: 'bash', argsRaw: '' }), true)
assert.equal(preparing({ kind: 'tool-call', name: 'bash', argsRaw: '{"command":"pwd"}' }), false)
assert.equal(preparing({ kind: 'tool-call', name: '', argsRaw: '' }), false)
assert.match(conversation, /streaming && xhPreparingCall\(block\)/)
assert.match(css, /\.xh-tool-preparing/)
console.log('upstream UI experience graph and patch tests passed')
