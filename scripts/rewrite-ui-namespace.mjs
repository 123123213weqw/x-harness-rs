// Move an assembled client graph onto the XHarness scope. Runs after every
// other patch step, so upstream package ids only exist while assembling; the
// shipped artifacts, their directories, identifiers, manifest revisions and
// boot manifest all spell the graph we publish.
//
// Idempotent: a second run finds nothing to rename and rewrites nothing.
// Fail-closed: any surviving upstream scope in a shippable artifact throws.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  UI_IDENTIFIER_PREFIX,
  UI_NAMESPACE,
  UPSTREAM_IDENTIFIER_PREFIX,
  UPSTREAM_NAMESPACE,
  pluginDir,
} from './ui-namespace.mjs'

// Extensions the assembler writes text into. Binary assets never carry a scope.
const TEXT = new Set(['.css', '.html', '.js', '.json', '.map', '.mjs', '.svg', '.txt', '.webmanifest', ''])

function revision(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16)
}

function textFiles(root) {
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (TEXT.has(extname(entry.name))) found.push(path)
    }
  }
  walk(root)
  return found
}

export function rewriteUiNamespace(dist) {
  const upstreamDir = pluginDir(dist, UPSTREAM_NAMESPACE)
  const shippedDir = pluginDir(dist, UI_NAMESPACE)
  let moved = 0

  if (existsSync(upstreamDir)) {
    // The repository's own product plugins may already live in the target scope.
    mkdirSync(shippedDir, { recursive: true })
    for (const name of readdirSync(upstreamDir)) {
      const target = join(shippedDir, name)
      if (existsSync(target)) throw new Error(`ui namespace collision for ${name}`)
      renameSync(join(upstreamDir, name), target)
      moved += 1
    }
    rmSync(upstreamDir, { recursive: true, force: true })
  }

  const rewrites = [
    [`${UPSTREAM_NAMESPACE}/`, `${UI_NAMESPACE}/`],
    [UPSTREAM_IDENTIFIER_PREFIX, UI_IDENTIFIER_PREFIX],
  ]
  let files = 0
  let occurrences = 0
  for (const path of textFiles(dist)) {
    const before = readFileSync(path, 'utf8')
    let after = before
    for (const [from, to] of rewrites) after = after.split(from).join(to)
    if (after === before) continue
    files += 1
    for (const [from] of rewrites) occurrences += before.split(from).length - 1
    writeFileSync(path, after)
  }

  // Plugin bytes changed, so every manifest revision and the boot manifest move.
  const graphPath = join(dist, 'client-graph.json')
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'))
  for (const entry of graph.entries) {
    const bytes = readFileSync(join(dist, entry.url.split('?')[0].slice(1)))
    entry.rev = revision(bytes)
    entry.url = `/plugins/${entry.id}/client.js?rev=${entry.rev}`
  }
  graph.rev = revision(Buffer.from(JSON.stringify(graph.entries)))
  writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`)
  const indexPath = join(dist, 'index.html')
  const index = readFileSync(indexPath, 'utf8')
  if (!index.includes('window.__DSH_BOOT__')) throw new Error('index.html has no boot manifest to refresh')
  writeFileSync(
    indexPath,
    index.replace(/window\.__DSH_BOOT__ = .*?<\/script>/, () => `window.__DSH_BOOT__ = ${JSON.stringify(graph)}</script>`),
  )

  return { moved, files, occurrences }
}

/** Text artifacts that still mention the upstream scope, and their counts. */
export function upstreamScopeSurvivors(dist) {
  const survivors = []
  for (const path of textFiles(dist)) {
    const text = readFileSync(path, 'utf8')
    const matches = text.split(UPSTREAM_NAMESPACE).length - 1
    if (matches > 0) survivors.push(`${relative(dist, path)} (${matches})`)
  }
  return survivors
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dist = process.argv[2] ?? 'ui/dist'
  if (!existsSync(dist) || !statSync(dist).isDirectory()) throw new Error(`${dist} is not an assembled dist`)
  const result = rewriteUiNamespace(dist)
  const survivors = upstreamScopeSurvivors(dist)
  if (survivors.length > 0) {
    throw new Error(`upstream scope survived the rewrite:\n  ${survivors.join('\n  ')}`)
  }
  console.log(
    `ui namespace: ${result.moved} plugin directories and ${result.occurrences} occurrences across ${result.files} files -> ${UI_NAMESPACE}`,
  )
}
