#!/usr/bin/env node

import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [upstreamArg, distArg] = process.argv.slice(2)
if (upstreamArg === undefined || distArg === undefined) {
  throw new Error('usage: assemble-static-ui.mjs <deepseek-harness> <dist>')
}

const upstream = resolve(upstreamArg)
const dist = resolve(distArg)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const layers = [
  {
    manifest: join(upstream, 'packages/bundle/base/package.json'),
    patch: join(upstream, 'packages/bundle/base/cordis.patch.yml'),
  },
  {
    manifest: join(upstream, 'packages/bundle/web-app/package.json'),
    patch: join(upstream, 'packages/bundle/web-app/cordis.patch.yml'),
  },
]
const resolvers = layers.map(layer => createRequire(layer.manifest))
const webResolver = resolvers[1]
if (webResolver === undefined) throw new Error('web bundle resolver is missing')

const appBoot = await import(pathToFileURL(webResolver.resolve('@deepseek-ai/dsh-app-boot')).href)
const clientModules = await import(
  pathToFileURL(webResolver.resolve('@deepseek-ai/dsh-client-modules')).href
)

function resolveManifest(specifier) {
  for (const require of resolvers) {
    try {
      return require.resolve(`${specifier}/package.json`)
    } catch {
      // The package may only exist in the other bundle layer.
    }
  }
  return undefined
}

function revision(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16)
}

// Some upstream bundlers retain absolute build-machine paths in region
// comments or source maps. They are not needed at runtime and make the checked
// in bundle non-reproducible as well as leaking the builder's home directory.
function portableBytes(bytes) {
  return Buffer.from(
    bytes
      .toString('utf8')
      .replaceAll(`${upstream}/`, 'deepseek-harness/')
      .replaceAll(`${repoRoot}/`, 'x-harness-rs/'),
  )
}

const composed = appBoot.composeEntries(
  layers.map(layer => appBoot.loadOverlayPatches('XHarness static UI', layer.patch)),
)
const plugins = new Map()
for (const entry of composed) {
  if (entry.disabled === true || typeof entry.name !== 'string') continue
  const packagePath = resolveManifest(entry.name)
  if (packagePath === undefined) continue
  const manifest = JSON.parse(readFileSync(packagePath, 'utf8'))
  const declaration = manifest.dsh?.client
  if (declaration?.platform !== 'web') continue
  const exported = manifest.exports?.['./client']
  const relative = typeof exported === 'string' ? exported : exported?.default
  if (relative === undefined) {
    throw new Error(`${entry.name} declares dsh.client without a ./client export`)
  }
  const source = resolve(dirname(packagePath), relative)
  const bytes = portableBytes(readFileSync(source))
  const rev = revision(bytes)
  plugins.set(entry.name, { declaration, source, bytes, rev })
}

// Product-owned Web plugins live in this repository instead of being patched
// into the upstream checkout. They participate in the same dependency graph
// and immutable revisioning as upstream client packages, so a rebuild cannot
// silently drop XHarness-only UI capabilities.
const productPlugins = [
  {
    id: '@xlang/xharness-client-ui-context',
    source: join(repoRoot, 'ui/plugins/@xlang/xharness-client-ui-context/client.js'),
    declaration: {
      platform: 'web',
      inject: [
        '@deepseek-ai/dsh-client-runtime',
        '@deepseek-ai/dsh-client-ui-conversation',
      ],
    },
  },
  {
    id: '@xlang/xharness-client-ui-schedule',
    source: join(repoRoot, 'ui/plugins/@xlang/xharness-client-ui-schedule/client.js'),
    declaration: {
      platform: 'web',
      inject: [
        '@deepseek-ai/dsh-client-runtime',
        '@deepseek-ai/dsh-client-locale',
        '@deepseek-ai/dsh-client-ui-conversation',
      ],
    },
  },
]
for (const product of productPlugins) {
  const bytes = portableBytes(readFileSync(product.source))
  plugins.set(product.id, {
    declaration: product.declaration,
    source: product.source,
    bytes,
    rev: revision(bytes),
  })
}

const unordered = [...plugins].map(([id, plugin]) => ({
  id,
  url: `/plugins/${id}/client.js?rev=${plugin.rev}`,
  rev: plugin.rev,
  ...(plugin.declaration.inject === undefined ? {} : { inject: plugin.declaration.inject }),
  ...(plugin.declaration.external === undefined ? {} : { external: plugin.declaration.external }),
  ...(plugin.declaration.immediately === true ? { immediately: true } : {}),
}))
const entries = clientModules.orderByModuleGraph(unordered)
const graph = {
  rev: revision(Buffer.from(JSON.stringify(entries))),
  entries,
}

const pluginRoot = join(dist, 'plugins')
rmSync(pluginRoot, { recursive: true, force: true })
for (const entry of entries) {
  const plugin = plugins.get(entry.id)
  if (plugin === undefined) throw new Error(`ordered unknown client package ${entry.id}`)
  const target = join(pluginRoot, entry.id, 'client.js')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, plugin.bytes)
  const sourceMap = `${plugin.source}.map`
  try {
    writeFileSync(`${target}.map`, portableBytes(readFileSync(sourceMap)))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

const indexPath = join(dist, 'index.html')
const index = readFileSync(indexPath, 'utf8')
if (index.includes('window.__DSH_BOOT__')) {
  throw new Error('index.html already contains a client boot manifest; assemble from a clean Vite dist')
}
writeFileSync(indexPath, clientModules.injectBootManifest(index, graph))
writeFileSync(join(dist, 'client-graph.json'), `${JSON.stringify(graph, null, 2)}\n`)
console.log(`assembled ${entries.length} client plugins (graph ${graph.rev}) into ${dist}`)
