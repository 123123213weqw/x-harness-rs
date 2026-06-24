#!/usr/bin/env node
// Keep the transcript and composer on one narrower reading column. The root
// custom property is already shared by messages, status rows, and input chrome;
// changing it here avoids mismatched alignment between those surfaces.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const BEFORE = '--dsh-chat-content-width:748px'
const AFTER = '--dsh-chat-content-width:680px'
const hash = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 16)

export function patchChatReadingWidth(id, input) {
  if (!id.endsWith('/dsh-client-ui-conversation')) return input
  const source = input.toString()
  if (source.includes(AFTER)) return Buffer.from(source)
  if (source.split(BEFORE).length !== 2) throw new Error('chat width: expected one root width anchor')
  return Buffer.from(source.replace(BEFORE, AFTER))
}

export function patchChatReadingWidthDist(dist) {
  const id = '@xharness/dsh-client-ui-conversation'
  const path = resolve(dist, 'plugins', id, 'client.js')
  const before = readFileSync(path)
  const after = patchChatReadingWidth(id, before)
  if (!after.equals(before)) writeFileSync(path, after)
  const graphPath = resolve(dist, 'client-graph.json')
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'))
  const entry = graph.entries.find(item => item.id === id)
  if (!entry) throw new Error(`chat width: missing graph entry ${id}`)
  entry.rev = hash(after)
  entry.url = `/plugins/${id}/client.js?rev=${entry.rev}`
  graph.rev = hash(Buffer.from(JSON.stringify(graph.entries)))
  const htmlPath = resolve(dist, 'index.html')
  let html = readFileSync(htmlPath, 'utf8')
  const boot = html.match(/window\.__DSH_BOOT__ = (.*?)<\/script>/)
  if (!boot) throw new Error('chat width: missing HTML boot graph')
  html = html.replace(boot[0], `window.__DSH_BOOT__ = ${JSON.stringify(graph)}</script>`)
  writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`)
  writeFileSync(htmlPath, html)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  patchChatReadingWidthDist(resolve(process.argv[2] ?? 'ui/dist'))
}
