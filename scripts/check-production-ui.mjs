#!/usr/bin/env node
// Fail closed before sealing or packaging UI assets, including renamed fixture output.
import {readFileSync} from 'node:fs'
import {resolve, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {OUTPUT_MARKER, treeHashes} from './ui-build-contract.mjs'
import {assertProductionSources, CONNECTION_ID, PRODUCTION_CONNECTION} from './ui-build-variant.mjs'
export function checkProductionUi(directory) {
  const marker = JSON.parse(readFileSync(join(directory, OUTPUT_MARKER), 'utf8'))
  if (marker.schemaVersion !== 1 || marker.builder !== 'xharness-self-contained-ui' || marker.variant !== 'production'
    || !marker.moduleSources || !Array.isArray(marker.moduleSources[CONNECTION_ID])
    || !marker.moduleSources[CONNECTION_ID].includes(PRODUCTION_CONNECTION)) throw Error('Packaging requires a production UI build')
  for (const sources of Object.values(marker.moduleSources)) {
    if (!Array.isArray(sources) || sources.some(source => typeof source !== 'string')) throw Error('Invalid production module provenance')
    assertProductionSources(sources)
  }
  const inventory = JSON.parse(readFileSync(join(directory, 'asset-manifest.json'), 'utf8'))
  const hashes = treeHashes(directory)
  if (inventory.schemaVersion !== 1 || !inventory.files || Object.keys(hashes).length !== Object.keys(inventory.files).length + 1) throw Error('Invalid production UI inventory')
  for (const [path, entry] of Object.entries(inventory.files)) {
    if (hashes[path] !== entry.sha256) throw Error(`Production UI hash mismatch: ${path}`)
    if (path.endsWith('.js') && /FixtureApiClient|src\/modules\/client-connection\/fixture(?:-entry)?\.ts/.test(readFileSync(join(directory, path), 'utf8'))) throw Error(`Fixture code found in production output: ${path}`)
  }
  return marker
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) throw Error('usage: check-production-ui.mjs [OUTPUT_DIRECTORY]')
  checkProductionUi(resolve(process.argv[2] ?? fileURLToPath(new URL('../ui/dist', import.meta.url))))
  console.log('Production UI provenance and asset hashes verified')
}
