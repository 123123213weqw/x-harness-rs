// Validate real HTTP replies against the schemas embedded in the shipped client.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { pluginPath } from './ui-namespace.mjs'
const verbs = ['create', 'edit', 'pause', 'resume', 'complete', 'clear']
const dist = fileURLToPath(new URL('../ui/dist', import.meta.url))
const source = readFileSync(pluginPath(dist, '@xharness/dsh-api-remotes'), 'utf8')
const names = verbs.map(verb => {
  const match = source.match(new RegExp(`const (\\w+_goals_${verb}_result\\$schema) =`))
  assert.ok(match, `missing shipped schema: ${verb}`)
  return `${JSON.stringify(verb)}: ${match[1]}`
})
let schemas
vm.runInNewContext(source.replace('return module.exports;', `return {${names.join(',')}};`), {
  window: { __ModuleLoader__: { load({ factory }) { schemas = factory(() => { throw Error('unexpected dependency') }) } } },
})
assert.equal(schemas.clear.safeParse({ cleared: true }).success, false, 'old backend reply must be rejected')
assert.equal(schemas.clear.safeParse({ id: 'goal', revision: 2 }).success, true)
assert.equal(schemas.clear.safeParse({ id: 'goal', revision: '2' }).success, false)
assert.equal(schemas.edit.safeParse({ ref: { id: 'goal', revision: 2 } }).success, false)
if (process.argv[2]) {
  const replies = JSON.parse(readFileSync(process.argv[2], 'utf8'))
  for (const verb of verbs) {
    const checked = schemas[verb].safeParse(replies[verb])
    assert.equal(checked.success, true, `${verb}: ${checked.error?.message}`)
  }
  console.log('Goal remote contract: all 6 real Host HTTP replies accepted by shipped schemas')
} else {
  console.log('Goal remote contract: regression/negative schema checks passed')
}
