#!/usr/bin/env node
// Update only the two composer/connection bundles in an already assembled UI.
// This preserves unrelated product-plugin work in a locally running checkout.
import {createHash} from 'node:crypto'
import {readFileSync, writeFileSync} from 'node:fs'
import {join, resolve} from 'node:path'
import {patchContextComposition, patchContextCompositionConnection} from './patch-context-composition.mjs'

const dist = resolve(process.argv[2] ?? 'ui/dist')
const graphPath = join(dist, 'client-graph.json')
const indexPath = join(dist, 'index.html')
const graph = JSON.parse(readFileSync(graphPath, 'utf8'))
let index = readFileSync(indexPath, 'utf8')
const changes = []
for (const [id, patch] of [
  ['@xharness/dsh-client-ui-conversation', patchContextComposition],
  ['@xharness/dsh-client-connection', patchContextCompositionConnection],
]) {
  const entry = graph.entries.find(item => item.id === id)
  if (!entry) throw Error(`missing ${id} from client graph`)
  const path = join(dist, 'plugins', id, 'client.js')
  const before = readFileSync(path)
  const after = patch(before)
  const rev = createHash('sha256').update(after).digest('hex').slice(0, 16)
  const oldUrl = entry.url
  const url = `/plugins/${id}/client.js?rev=${rev}`
  if (!index.includes(oldUrl)) throw Error(`index.html does not reference ${oldUrl}`)
  index = index.replaceAll(oldUrl, url)
  entry.rev = rev
  entry.url = url
  changes.push([path, after])
}
graph.rev = createHash('sha256').update(JSON.stringify(graph.entries)).digest('hex').slice(0, 16)
const marker = 'window.__DSH_BOOT__ = '
const start = index.indexOf(marker)
const end = index.indexOf('</script>', start)
if (start < 0 || end < 0) throw Error('index.html boot graph anchor changed')
const bootStart = start + marker.length
const boot = JSON.parse(index.slice(bootStart, end))
boot.rev = graph.rev
for (const entry of graph.entries) {
  const current = boot.entries.find(item => item.id === entry.id)
  if (current) {
    current.url = entry.url
    current.rev = entry.rev
  }
}
index = index.slice(0, bootStart) + JSON.stringify(boot) + index.slice(end)
for (const [path, bytes] of changes) writeFileSync(path, bytes)
writeFileSync(graphPath, JSON.stringify(graph, null, 2) + '\n')
writeFileSync(indexPath, index)
console.log(`updated context composition in ${dist}; graph ${graph.rev}`)
