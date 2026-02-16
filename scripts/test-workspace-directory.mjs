import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = fileURLToPath(new URL('../', import.meta.url))
const dist = resolve(process.argv[2] ?? resolve(root, 'ui/dist'))
const id = '@xlang/xharness-client-ui-directory'
const read = path => readFileSync(path, 'utf8').replaceAll('\r\n', '\n')
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16)
const graph = JSON.parse(read(resolve(dist, 'client-graph.json')))
const entry = graph.entries.find(entry => entry.id === id)
assert.ok(entry, 'static UI must include workspace directory flow, not only the Node auto-picker')
const source = read(resolve(root, `ui/plugins/${id}/client.js`))
const shipped = read(resolve(dist, `plugins/${id}/client.js`))
assert.equal(shipped, source, 'packaged directory UI is stale')
assert.equal(entry.rev, hash(shipped))
assert.equal(entry.url, `/plugins/${id}/client.js?rev=${entry.rev}`)
assert.equal(graph.rev, hash(JSON.stringify(graph.entries)))
for (const dep of entry.inject) {
  assert.ok(graph.entries.findIndex(e => e.id === dep) >= 0, `missing dependency ${dep}`)
  assert.ok(graph.entries.findIndex(e => e.id === dep) < graph.entries.indexOf(entry), `unordered ${dep}`)
}
const boot = read(resolve(dist, 'index.html')).match(/window\.__DSH_BOOT__ = (.*?)<\/script>/)
assert.ok(boot, 'HTML boot manifest required')
assert.deepEqual(JSON.parse(boot[1]), graph)
assert.ok(read(resolve(root, 'scripts/assemble-static-ui.mjs')).includes(id), 'full rebuild must retain directory flow')

let registration
vm.runInNewContext(shipped, { window: { __ModuleLoader__: { load: value => { registration = value } } } })
assert.equal(registration.id, id)
const client = registration.factory(name => {
  if (name === 'react') return {}
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
  throw Error(`unexpected dependency ${name}`)
})
assert.deepEqual([...client.inject], ['slots', 'workspaces', 'locale'])
const slots = []
const calls = []
client.apply({
  effect: () => {},
  locale: { bind: () => key => key },
  workspaces: {
    listDirectory: (...args) => { calls.push(args); return 'listing' },
    createDirectory: (...args) => { calls.push(args); return 'created' },
  },
  slots: {
    inject: (_name, factory) => factory(),
    register: (definition, component) => { slots.push({ definition, component }); return () => {} },
  },
})
assert.deepEqual(slots.map(s => s.definition.name).sort(), [
  'conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow',
])
for (const slot of slots) {
  const injected = slot.definition.inject()
  const signal = new AbortController().signal
  assert.equal(injected.listDirectory('D:\\中文 workspace', signal), 'listing')
  assert.equal(calls.at(-1)[1], signal)
  assert.equal(injected.createDirectory('D:\\中文 workspace', '子目录'), 'created')
  assert.deepEqual(calls.at(-1), ['D:\\中文 workspace', '子目录'])
}
console.log('directory flow: both slots, service forwarding, source/dist, dependency order and boot graph verified')
