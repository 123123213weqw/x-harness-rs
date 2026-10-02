import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readInput } from '../ui-build-contract.mjs'
import { compileSourceModules } from '../build-source-modules.mjs'
const ui = fileURLToPath(new URL('../../ui/', import.meta.url))
export const uiManifest = JSON.parse(readFileSync(resolve(ui, 'modules.json'), 'utf8'))
let compiled
export function assertRebuildInput(id) {
  const entry = uiManifest.modules.find(row => row.id === id)
  assert.ok(entry, `repository build includes ${id}`)
  let expected
  if (entry.kind === 'source-module') {
    compiled ??= compileSourceModules(ui, uiManifest.modules.filter(row => row.kind === 'source-module'))
    expected = compiled.get(id).bytes
  } else {
    assert.equal(entry.kind, 'classic-js')
    expected = readInput(ui, entry)
  }
  assert.deepEqual(expected, readFileSync(resolve(process.env.UI_TEST_DIST ?? resolve(ui, 'dist'), 'plugins', id, 'client.js')), `repository input builds ${id}`)
  return entry
}
