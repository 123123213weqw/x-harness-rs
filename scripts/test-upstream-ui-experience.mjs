import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import {assertRebuildInput} from './fixtures/repository-ui-input.mjs'
import {sourceDeclaration} from './fixtures/source-declaration.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const graph = JSON.parse(readFileSync(resolve(root, 'ui/dist/client-graph.json'), 'utf8'))
const html = readFileSync(resolve(root, 'ui/dist/index.html'), 'utf8')
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16)
const readCanonical = path => Buffer.from(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'))
for (const id of [
  '@xharness/dsh-client-ui-tool',
  '@xharness/dsh-client-ui-conversation',
  '@xharness/dsh-client-ui-model-selection',
]) {
  const code = readCanonical(resolve(root, `ui/dist/plugins/${id}/client.js`))
  assertRebuildInput(id)
  const entry = graph.entries.find(value => value.id === id)
  assert.equal(entry.rev, hash(code), `${id} graph revision`)
}
const productId = '@xlang/xharness-client-ui-experience'
assertRebuildInput(productId)
const product = readCanonical(resolve(root, `ui/dist/plugins/${productId}/client.js`))
const shipped = readCanonical(resolve(root, `ui/dist/plugins/${productId}/client.js`))
assert.deepEqual(shipped, product)
assert.equal(graph.entries.find(value => value.id === productId)?.rev, hash(product))
assert.ok(graph.entries.indexOf(graph.entries.find(value => value.id === productId)) > graph.entries.indexOf(graph.entries.find(value => value.id === '@xharness/dsh-client-ui-settings')))
assert.match(html, /@xlang\/xharness-client-ui-experience/)
assert.match(html, new RegExp(`"rev":"${graph.rev}"`))
const tool = readFileSync(resolve(root, 'ui/dist/plugins/@xharness/dsh-client-ui-tool/client.js'), 'utf8')
assert.ok((tool.match(/XHReviewDiffBlock/g) ?? []).length >= 2, 'both row/detail keep actual shared review component');assertRebuildInput('@xharness/dsh-client-ui-tool')
assert.match(tool, /target: "_blank", rel: "noopener noreferrer"/)
assert.match(tool, /data-state|"preparing"/)
const css = readFileSync(resolve(root, 'ui/dist/monochrome.css'), 'utf8')
assert.match(css, /xh-model-switching/)
assert.match(css, /prefers-reduced-motion/)
const conversation = readFileSync(resolve(root, 'ui/dist/plugins/@xharness/dsh-client-ui-conversation/client.js'), 'utf8')
const preparing = vm.runInNewContext(sourceDeclaration(conversation,'preparingCall')+';preparingCall')
assert.equal(preparing({ kind: 'tool-call', name: 'bash', argsRaw: '{"command":' }), true)
assert.equal(preparing({ kind: 'tool-call', name: 'bash', argsRaw: '' }), true)
assert.equal(preparing({ kind: 'tool-call', name: 'bash', argsRaw: '{"command":"pwd"}' }), false)
assert.equal(preparing({ kind: 'tool-call', name: '', argsRaw: '' }), false)
assert.match(conversation,/streaming && (?:\(0, [\w.]+\.preparingCall\)|preparingCall)\(block\)/)
assert.match(css, /\.xh-tool-preparing/)
console.log('upstream UI experience graph and native behavior tests passed')
