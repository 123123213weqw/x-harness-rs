#!/usr/bin/env node
// Self-contained XHarness UI assembly. All inputs live under this repository's
// ui/ tree; product modules and the browser platform are built from source.
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { localPath, OUTPUT_MARKER, orderModules, readInput, renderBoot, revision, sha256, treeHashes } from './ui-build-contract.mjs'
import { compileSourceModules } from './build-source-modules.mjs'
import { compileScriptAssets } from './build-script-assets.mjs'
import { compilePlatformUi } from './build-platform-ui.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ui = join(repoRoot, 'ui')
const args = process.argv.slice(2)
let output = join(ui, 'dist'), check = false, hasOutput = false
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out-dir' && !hasOutput && args[i + 1]) { output = resolve(args[++i]); hasOutput = true }
  else if (args[i] === '--check' && !check) check = true
  else throw Error('usage: assemble-static-ui.mjs [--out-dir PATH] [--check]; no external source directory is accepted')
}
if (output === repoRoot || repoRoot.startsWith(output + sep) || (output.startsWith(repoRoot + sep) && output !== join(ui, 'dist'))) throw Error('Output would overwrite repository inputs')
if (existsSync(output) && lstatSync(output).isSymbolicLink()) throw Error('Output must not be a symlink')
if (existsSync(output) && !lstatSync(output).isDirectory()) throw Error('Output must be a directory')
mkdirSync(dirname(output), { recursive: true })
output = join(realpathSync(dirname(output)), basename(output))
if (output === repoRoot || repoRoot.startsWith(output + sep) || (output.startsWith(repoRoot + sep) && output !== join(ui, 'dist'))) throw Error('Output parent aliases repository inputs')
if (!check && output !== join(ui, 'dist') && existsSync(output)) {
  const marker = join(output, OUTPUT_MARKER)
  if (!existsSync(marker) || JSON.parse(readFileSync(marker, 'utf8')).builder !== 'xharness-self-contained-ui') throw Error('Refusing to replace an unowned output directory')
}

const manifest = JSON.parse(readInput(ui, { source: 'modules.json' }).toString('utf8'))
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.modules) || !manifest.modules.length || !Array.isArray(manifest.assets)) throw Error('Invalid repository UI manifest')
if (manifest.modules.some(row => !['source-module', 'plugin-api-ts'].includes(row.kind))) throw Error('Production modules must compile from owned TypeScript source')
if (manifest.bootTemplate?.source !== 'src/index.template.html' || manifest.platform?.kind !== 'source-platform') throw Error('Production boot must compile the owned browser platform')
if (manifest.assets.some(row => row.source.startsWith('legacy/')) || manifest.frozenOverrides !== undefined) throw Error('Legacy references are test-only, not production assembly inputs')
const sourceModules = compileSourceModules(ui, manifest.modules.filter(row => row.kind === 'source-module'))
const scriptAssets = compileScriptAssets(ui, manifest.assets.filter(row => row.kind === 'script-ts'))
const modules = orderModules(manifest.modules.map(row => sourceModules.has(row.id)
  ? { ...row, external: [...new Set([...(row.external ?? []), ...sourceModules.get(row.id).external])] }
  : row))
const template = readInput(ui, manifest.bootTemplate).toString('utf8')
if (manifest.platform !== undefined && manifest.platform.kind !== 'source-platform') throw Error('Invalid source platform kind')
const platform = manifest.platform ? compilePlatformUi(ui, manifest.platform) : undefined
const stage = mkdtempSync(join(dirname(output), '.xharness-ui-stage-'))
try {
  const files = new Map(), entries = []
  const put = (path, bytes) => {
    localPath(path, 'output path')
    if (files.has(path)) throw Error(`Duplicate output path: ${path}`)
    files.set(path, Buffer.from(bytes))
  }
  for (const row of modules) {
    const path = `plugins/${row.id}/client.js`
    let bytes = readInput(ui, row)
    if (row.kind === 'source-module') bytes = sourceModules.get(row.id).bytes
    else if (row.kind === 'plugin-api-ts') {
      if (row.id !== '@xlang/xharness-client-plugin-api' || row.source !== 'src/plugin-api/client.ts') throw Error('Invalid TypeScript entry')
      execFileSync(process.execPath, [join(repoRoot, 'scripts/build-plugin-api.mjs'), '--output', join(stage, path)], { stdio: 'inherit' })
      bytes = readFileSync(join(stage, path))
    } else throw Error(`Unknown module kind: ${row.id}`)
    let registrations = 0
    runInNewContext(bytes.toString('utf8'), { window: { __ModuleLoader__: { load(registration) {
      if (registration.id !== row.id || typeof registration.factory !== 'function') throw Error(`Invalid factory: ${row.id}`)
      registrations++
    } } } }, { timeout: 1000, filename: path })
    if (registrations !== 1) throw Error(`Module must register exactly one factory: ${row.id}`)
    const rev = revision(bytes)
    entries.push({ id: row.id, url: `/${path}?rev=${rev}`, rev,
      ...(row.inject !== undefined ? { inject: row.inject } : {}),
      ...(row.external !== undefined ? { external: row.external } : {}),
      ...(row.immediately === true ? { immediately: true } : {}) })
    put(path, bytes)
  }
  const staleSourceMaps = new Set(modules.filter(row => row.kind === 'source-module').map(row => `plugins/${row.id}/client.js.map`))
  for (const asset of manifest.assets) {
    if (staleSourceMaps.has(asset.path)) throw Error(`Obsolete legacy source map for owned source module: ${asset.path}`)
    if (['index.html', 'client-graph.json', 'asset-manifest.json', OUTPUT_MARKER].includes(asset.path)) throw Error('Reserved output asset')
    if (asset.kind !== undefined && asset.kind !== 'script-ts') throw Error(`Unknown asset kind: ${asset.kind}`)
    if (asset.path.endsWith('.js') && asset.kind !== 'script-ts'
      && !(asset.path === 'plugins/@xlang/xharness-client-ui-terminal/vendor/xterm.js'
        && asset.source === asset.path && /^[a-f0-9]{64}$/.test(asset.sha256))) throw Error('Plain JavaScript assets must be the pinned original xterm library')
    put(asset.path, scriptAssets.has(asset.path) ? scriptAssets.get(asset.path).bytes : readInput(ui, asset))
  }
  if (platform) {
    for (const [path, bytes] of platform.outputs) put(path, bytes)
  }
  const graph = { rev: revision(JSON.stringify(entries)), entries }
  put('client-graph.json', `${JSON.stringify(graph, null, 2)}\n`)
  put('index.html', renderBoot(template, graph, files, platform ? {...platform, preloadBootBytes: platform.inlineBootBytes.toString('utf8')} : undefined))
  put(OUTPUT_MARKER, `${JSON.stringify({ schemaVersion: 1, builder: 'xharness-self-contained-ui' })}\n`)
  const inventory = Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([path, bytes]) => [path, { sha256: sha256(bytes), bytes: bytes.length }]))
  put('asset-manifest.json', `${JSON.stringify({ schemaVersion: 1, files: inventory }, null, 2)}\n`)
  for (const [path, bytes] of files) {
    const target = join(stage, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes)
  }
  if (check) {
    if (!existsSync(output) || JSON.stringify(treeHashes(stage)) !== JSON.stringify(treeHashes(output))) throw Error('UI output is stale; npm run build --prefix ui')
  } else {
    // Publish only after complete validation. Roll back if the final rename
    // fails; a missing input or compiler error never destroys the last build.
    const backup = stage + '.previous'
    const hadOutput = existsSync(output)
    if (hadOutput) renameSync(output, backup)
    try { renameSync(stage, output) }
    catch (error) { if (hadOutput) renameSync(backup, output); throw error }
    if (hadOutput) rmSync(backup, { recursive: true })
  }
  console.log(`XHarness UI ${check ? 'verified' : 'built'}: ${entries.length} modules, ${files.size - entries.length} assets; repository inputs only`)
} finally { if (existsSync(stage)) rmSync(stage, { recursive: true }) }
