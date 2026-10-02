// Validate real HTTP replies against the schemas embedded in the shipped client.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { verifyArtifact } from './fixtures/shipped-source-values.mjs'
const verbs = ['create', 'edit', 'pause', 'resume', 'complete', 'clear']
// Capture the actual public Remote contribution; lexical bundler variable
// names and nested CommonJS returns are not part of the Host contract.
const source = verifyArtifact('@xharness/dsh-api-remotes')
let registration
vm.runInNewContext(source, {
  window: { __ModuleLoader__: { load(row) { registration = row } } },
})
assert.equal(registration.id, '@xharness/dsh-api-remotes')
const api = registration.factory(id => { throw Error(`unexpected dependency: ${id}`) })
const contributions = []
const dispose = await api.apply({ remote: { $mount: async contribution => {
  contributions.push(contribution)
  return async () => {}
} } })
const goals = contributions.filter(row => row.package === '@xharness/dsh-goal')
assert.equal(goals.length, 1, 'exact actual goals contribution')
const schemas = Object.fromEntries(verbs.map(verb => {
  const descriptors = goals[0].descriptors.filter(row => row.namespace === 'goals' && row.method === verb)
  assert.equal(descriptors.length, 1, `one actual shipped goal schema: ${verb}`)
  const descriptor = descriptors[0]
  assert.equal(descriptor.result.mode, 'strict')
  assert.equal(typeof descriptor.result.schema.safeParse, 'function')
  return [verb, descriptor.result.schema]
}))
await dispose()
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
