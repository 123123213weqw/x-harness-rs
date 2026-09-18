// The shipped graph must not carry the upstream scope: ids, plugin directories,
// manifest urls and bundler-derived identifiers are all rewritten at assembly.
// Fails closed if a rebuild reintroduces upstream naming.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rewriteUiNamespace, upstreamScopeSurvivors } from './rewrite-ui-namespace.mjs'
import { UI_IDENTIFIER_PREFIX, UI_NAMESPACE, UPSTREAM_IDENTIFIER_PREFIX, UPSTREAM_NAMESPACE, pluginDir, pluginPath } from './ui-namespace.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const dist = resolve(root, 'ui/dist')
const revision = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 16)

const graph = JSON.parse(readFileSync(join(dist, 'client-graph.json'), 'utf8'))
const ids = graph.entries.map(entry => entry.id)

assert.ok(ids.length > 0, 'graph has entries')
assert.equal(ids.filter(id => id.startsWith(`${UPSTREAM_NAMESPACE}/`)).length, 0, `no ${UPSTREAM_NAMESPACE} ids in the graph`)
assert.ok(ids.some(id => id.startsWith(`${UI_NAMESPACE}/`)), `graph ships ${UI_NAMESPACE} ids`)
assert.deepEqual(upstreamScopeSurvivors(dist), [], 'no upstream scope left in any text artifact')

// Plugin directories, urls, revisions and the boot manifest must agree.
assert.equal(readdirSync(join(dist, 'plugins')).includes(UPSTREAM_NAMESPACE), false, 'no upstream plugin directory')
assert.ok(readdirSync(join(dist, 'plugins')).includes(UI_NAMESPACE), 'shipped plugin directory exists')
const index = readFileSync(join(dist, 'index.html'), 'utf8')
assert.ok(index.includes(`window.__DSH_BOOT__ = ${JSON.stringify(graph)}`), 'boot manifest matches client-graph.json')
for (const entry of graph.entries) {
  assert.equal(entry.url, `/plugins/${entry.id}/client.js?rev=${entry.rev}`, `url matches id for ${entry.id}`)
  const bytes = readFileSync(pluginPath(dist, entry.id))
  assert.equal(entry.rev, revision(bytes), `revision matches shipped bytes for ${entry.id}`)
  const text = bytes.toString('utf8')
  assert.equal(text.includes(UPSTREAM_IDENTIFIER_PREFIX), false, `no upstream identifier in ${entry.id}`)
  assert.equal(text.includes(`${UPSTREAM_NAMESPACE}/`), false, `no upstream require in ${entry.id}`)
}
assert.equal(graph.rev, revision(Buffer.from(JSON.stringify(graph.entries))), 'graph revision covers its entries')
const shippedPlugins = readdirSync(pluginDir(dist)).map(name => `${UI_NAMESPACE}/${name}`)
assert.ok(
  shippedPlugins.some(id => readFileSync(pluginPath(dist, id)).toString('utf8').includes(UI_IDENTIFIER_PREFIX)),
  'bundler-derived identifiers follow the shipped scope',
)

// Re-running the rewrite is a no-op, and it fails closed when the upstream
// scope is still present but the plugin directory moved.
assert.deepEqual(rewriteUiNamespace(dist), { moved: 0, files: 0, occurrences: 0 }, 'rewrite is idempotent on a shipped dist')

const scratch = mkdtempSync(join(tmpdir(), 'ui-namespace-'))
try {
  cpSync(join(dist, 'client-graph.json'), join(scratch, 'client-graph.json'))
  cpSync(join(dist, 'index.html'), join(scratch, 'index.html'))
  cpSync(join(dist, 'plugins'), join(scratch, 'plugins'), { recursive: true })
  const stale = join(scratch, 'plugins', UPSTREAM_NAMESPACE)
  cpSync(pluginDir(scratch), stale, { recursive: true })
  const staleEntry = join(stale, 'dsh-client-ui-goal', 'client.js')
  writeFileSync(staleEntry, readFileSync(staleEntry, 'utf8').replaceAll(`${UI_NAMESPACE}/`, `${UPSTREAM_NAMESPACE}/`))
  assert.throws(() => rewriteUiNamespace(scratch), /collision/, 'a half-migrated dist is rejected instead of silently merged')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`ui namespace: ${ids.length} plugins ship on ${UI_NAMESPACE}, no ${UPSTREAM_NAMESPACE} scope, manifest/hash/idempotence/fail-closed checks passed`)
