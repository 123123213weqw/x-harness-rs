// The carrier accepts a named product presentation extension. It keeps its
// interior opaque; the versioned compaction projector owns domain validation.
// Both history and live mux already use this same schema.
import {createHash} from 'node:crypto'
import {readFileSync, writeFileSync, unlinkSync} from 'node:fs'
import {resolve} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

export const LEGACY_VIEW_SCHEMA = `\t\tconst toolEventViewSchema = discriminatedUnion("for", [object({
\t\t\tfor: literal("call"),
\t\t\tview: looseObject({ card: string() })
\t\t}), object({
\t\t\tfor: literal("result"),
\t\t\tview: looseObject({ card: string() })
\t\t})]);`
export const COMPACTION_VIEW_SCHEMA = LEGACY_VIEW_SCHEMA.replace('\t\t})]);', `\t\t}), object({
\t\t\tfor: literal("compaction"),
\t\t\t// Preserve the versioned product payload, including progress and future
\t\t\t// fields. Its owning renderer validates or falls back to durable facts.
\t\t\tview: looseObject({})
\t\t})]);`)
const marker = '// xh-compaction-wire/v1\n'
export function patchCompactionWire(bytes) {
  const source = bytes.toString('utf8')
  if (source.includes(marker)) {
    if (source.split(marker).length !== 2 || source.split(COMPACTION_VIEW_SCHEMA).length !== 2) throw Error('compaction wire: malformed or duplicate extension')
    return Buffer.from(source)
  }
  if (source.split(LEGACY_VIEW_SCHEMA).length !== 2) throw Error('compaction wire: carrier schema anchor changed')
  return Buffer.from(source.replace(LEGACY_VIEW_SCHEMA, marker + COMPACTION_VIEW_SCHEMA))
}

export function syncCompactionWire(dist) {
  const id = '@xharness/dsh-client-connection'
  const file = resolve(dist, 'plugins', id, 'client.js')
  const graphPath = resolve(dist, 'client-graph.json'), htmlPath = resolve(dist, 'index.html')
  const bytes = patchCompactionWire(readFileSync(file))
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'))
  const matches = graph.entries.filter(entry => entry.id === id)
  if (matches.length !== 1) throw Error('compaction wire: connection graph entry missing or ambiguous')
  const html = readFileSync(htmlPath, 'utf8'), pattern = /window\.__DSH_BOOT__ = .*?<\/script>/
  if (!pattern.test(html)) throw Error('compaction wire: boot graph missing')
  const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16)
  const entry = matches[0], previousUrl = entry.url
  entry.rev = hash(bytes); entry.url = `/plugins/${id}/client.js?rev=${entry.rev}`
  graph.rev = hash(JSON.stringify(graph.entries))
  const updatedHtml = html.replaceAll(previousUrl, entry.url).replace(pattern, () => `window.__DSH_BOOT__ = ${JSON.stringify(graph)}</script>`)
  // Validate all signatures before any write; no durable Session data involved.
  writeFileSync(file, bytes)
  try { unlinkSync(file + '.map') } catch (e) { if (e.code !== 'ENOENT') throw e }
  writeFileSync(graphPath, JSON.stringify(graph, null, 2) + '\n')
  writeFileSync(htmlPath, updatedHtml)
  return graph.rev
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log('compaction wire synchronized:', syncCompactionWire(resolve(process.argv[2] ?? fileURLToPath(new URL('../ui/dist', import.meta.url)))))
}
