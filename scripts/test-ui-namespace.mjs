// The shipped graph must not carry the upstream scope: ids, plugin directories,
// manifest urls and bundler-derived identifiers are all rewritten at assembly.
// Fails closed if a rebuild reintroduces upstream naming.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import vm from 'node:vm'
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
const survivors=upstreamScopeSurvivors(dist)
assert.deepEqual(survivors.filter(path=>!/^assets\/[^ ]+\.map \(/.test(path)), [], 'no upstream scope in runtime assets')
// Source maps keep real pinned third-party source and attribution. They must
// not be rewritten to fabricate ownership, nor hide own/runtime imports.
for(const survivor of survivors){
 const relative=survivor.replace(/ \(\d+\)$/, ''),map=JSON.parse(readFileSync(join(dist,relative),'utf8'))
 assert.ok(Array.isArray(map.sources)&&Array.isArray(map.sourcesContent))
 for(let i=0;i<map.sources.length;i++){
  const content=map.sourcesContent[i];if(!content?.includes(UPSTREAM_NAMESPACE))continue
  const actual=resolve(dirname(join(dist,relative)),map.sources[i])
  assert.ok(actual.startsWith(resolve(root,'ui/src/modules/platform/vendor')+'/'),'only genuine pinned vendor source may retain original namespace')
  assert.equal(content,readFileSync(actual,'utf8'),'source map retains original, unmodified source bytes')
 }
}

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
for(const entry of graph.entries){
 const declarations=[]
 vm.runInNewContext(readFileSync(join(dist,'plugins',entry.id,'client.js'),'utf8'),{window:{__ModuleLoader__:{load:row=>declarations.push(row.id)}}})
 assert.deepEqual(declarations,[entry.id],'actual factory registration follows graph namespace, regardless of compiler binding names')
}
// The historical rewriter is test-only. Never let it rewrite original vendor
// source-map contents in the canonical artifact merely to satisfy a test.

const scratch = mkdtempSync(join(tmpdir(), 'ui-namespace-'))
try {
  cpSync(join(dist, 'client-graph.json'), join(scratch, 'client-graph.json'))
  cpSync(join(dist, 'index.html'), join(scratch, 'index.html'))
  cpSync(join(dist, 'plugins'), join(scratch, 'plugins'), { recursive: true })
  assert.deepEqual(rewriteUiNamespace(scratch), {moved:0,files:0,occurrences:0}, 'runtime-only historical rewrite remains idempotent')
  const stale = join(scratch, 'plugins', UPSTREAM_NAMESPACE)
  cpSync(pluginDir(scratch), stale, { recursive: true })
  const staleEntry = join(stale, 'dsh-client-ui-goal', 'client.js')
  writeFileSync(staleEntry, readFileSync(staleEntry, 'utf8').replaceAll(`${UI_NAMESPACE}/`, `${UPSTREAM_NAMESPACE}/`))
  assert.throws(() => rewriteUiNamespace(scratch), /collision/, 'a half-migrated dist is rejected instead of silently merged')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`ui namespace: ${ids.length} plugins ship on ${UI_NAMESPACE}, no ${UPSTREAM_NAMESPACE} scope, manifest/hash/idempotence/fail-closed checks passed`)
