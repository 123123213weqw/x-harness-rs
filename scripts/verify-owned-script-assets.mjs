#!/usr/bin/env node
// Freshly strict-compile the actual TS scripts before checking shipped/package bytes.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {compileScriptAssets} from './build-script-assets.mjs'
const ui=resolve('ui'), manifest=JSON.parse(readFileSync(resolve(ui,'modules.json'),'utf8'))
const rows=manifest.assets.filter(row=>row.kind==='script-ts')
assert.ok(rows.length >= 4, 'all owned desktop scripts must be source-compiled')
for(const [path, built] of compileScriptAssets(ui, rows)) {
  assert.deepEqual(readFileSync(resolve(process.env.UI_TEST_DIST ?? resolve(ui,'dist'),path)),built.bytes,`stale source script: ${path}`)
}
console.log(`Strict owned script assets verified (${rows.length})`)
