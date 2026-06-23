import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { patchAgentPresetUi } from './patch-agent-preset-ui.mjs'

const dist = resolve('ui/dist')
const id = '@xharness/dsh-client-ui-agent-preset'
const graph = JSON.parse(readFileSync(resolve(dist, 'client-graph.json'), 'utf8'))
const bytes = readFileSync(resolve(dist, 'plugins', id, 'client.js'))
const source = bytes.toString()
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16)
const entry = graph.entries.find(item => item.id === id)

assert.ok(entry, 'Agent runtime bundle remains loaded')
assert.equal(entry.rev, hash(bytes))
assert.equal(graph.rev, hash(Buffer.from(JSON.stringify(graph.entries))))
assert.equal(patchAgentPresetUi(id, bytes).toString(), source, 'patch is idempotent')
assert.doesNotMatch(source, /scope\.slots\.register\(\{\s*name: "conversation\.hero\.agentPreset"/)
assert.doesNotMatch(source, /scope\.slots\.register\(\{\s*name: "conversation\.session\.header\.actions",\s*id: "agent-preset"/)
assert.doesNotMatch(source, /ctx\.slots\.inject\("settings\.general\.item"/)
assert.doesNotMatch(source, /ctx\.slots\.inject\("settings\.section"/)
assert.match(source, /AgentPresetSeatController/, 'runtime and existing preset state are retained')
assert.match(readFileSync('scripts/assemble-static-ui.mjs', 'utf8'), /bytes = patchAgentPresetUi\(entry\.name, bytes\)/)
console.log('agent preset UI: chooser, header, settings hidden; Host runtime and rebuild patch retained')
