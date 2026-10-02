// Test-only access to real emitted source units; production ABI stays unchanged.
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export function loadSourceInternals(id, externals, globals = {}) {
  const bytes = readFileSync(resolve(process.env.UI_TEST_DIST ?? 'ui/dist', 'plugins', id, 'client.js'), 'utf8')
  assert.match(bytes, /^\/\/ Generated from src\/modules\//)
  const pattern = /return __load\(("[^"\n]+")\);\n\}\n\}\);\s*$/
  assert.ok(pattern.test(bytes), 'test seam must address the owned bundler return, not arbitrary product code')
  const source = bytes.replace(pattern, 'return { public: __load($1), internal: __load };\n}\n});')
  let registration
  vm.runInNewContext(source, {...globals, window: {...globals.window, __ModuleLoader__: {load: row => {registration = row}}}})
  assert.equal(registration.id, id)
  return registration.factory(externals)
}
