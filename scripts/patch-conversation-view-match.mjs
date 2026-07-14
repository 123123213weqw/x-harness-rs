import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const marker = '// xh-conversation-view-match/v1'

// Keep the upstream Definition API compatible while allowing product-owned
// presentation views to drive matching without parsing durable event data.
export function patchConversationViewMatch(bytes) {
  let source = bytes.toString()
  if (source.includes(marker)) return Buffer.from(source)
  const once = (before, after) => {
    if (source.split(before).length !== 2) throw Error('conversation view-match anchor changed: ' + before)
    source = source.replace(before, after)
  }
  once('const result = definition.match(input.event);', `${marker}\n\t\t\t\t\tconst result = definition.match(input.event, input.view);`)
  once('const result = fallback.match(input.event);', 'const result = fallback.match(input.event, input.view);')
  return Buffer.from(source)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = resolve(process.argv[2] ?? 'ui/dist')
  const path = resolve(dist, 'plugins/@xharness/dsh-client-runtime/client.js')
  const bytes = patchConversationViewMatch(readFileSync(path))
  writeFileSync(path, bytes)
  const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16)
  const graphPath = resolve(dist, 'client-graph.json')
  const graph = JSON.parse(readFileSync(graphPath))
  const entry = graph.entries.find(candidate => candidate.id === '@xharness/dsh-client-runtime')
  const previousUrl = entry.url
  entry.rev = hash(bytes)
  entry.url = `/plugins/${entry.id}/client.js?rev=${entry.rev}`
  graph.rev = hash(JSON.stringify(graph.entries))
  writeFileSync(graphPath, JSON.stringify(graph, null, 2) + '\n')
  const indexPath = resolve(dist, 'index.html')
  writeFileSync(indexPath, readFileSync(indexPath, 'utf8').replaceAll(previousUrl, entry.url).replace(/window\.__DSH_BOOT__ = .*?<\/script>/, () => `window.__DSH_BOOT__ = ${JSON.stringify(graph)}</script>`))
}
