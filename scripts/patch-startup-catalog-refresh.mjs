import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const caseAnchor = '\t\t\t\t\tcase "host/session-added":'
const catalogCase = `\t\t\t\t\tcase "host/remote-event":
\t\t\t\t\t\tif (frame.event === "xharness/catalog-updated") {
\t\t\t\t\t\t\tthis.xhCatalogRefreshRequested = true;
\t\t\t\t\t\t\tif (!this.xhCatalogRefreshRunning) {
\t\t\t\t\t\t\t\tthis.xhCatalogRefreshRunning = true;
\t\t\t\t\t\t\t\tvoid (async () => {
\t\t\t\t\t\t\t\t\ttry {
\t\t\t\t\t\t\t\t\t\tdo {
\t\t\t\t\t\t\t\t\t\t\tif (this.listInflight !== null) await this.listInflight;
\t\t\t\t\t\t\t\t\t\t\tthis.xhCatalogRefreshRequested = false;
\t\t\t\t\t\t\t\t\t\t\tawait this.refreshList();
\t\t\t\t\t\t\t\t\t\t} while (this.xhCatalogRefreshRequested);
\t\t\t\t\t\t\t\t\t} finally {
\t\t\t\t\t\t\t\t\t\tthis.xhCatalogRefreshRunning = false;
\t\t\t\t\t\t\t\t}
\t\t\t\t\t\t\t\t})();
\t\t\t\t\t\t\t}
\t\t\t\t\t\t}
\t\t\t\t\t\treturn;
`
const priorSimpleCase = '\t\t\t\t\tcase "host/remote-event":\n\t\t\t\t\t\tif (frame.event === "xharness/catalog-updated") void this.refreshList();\n\t\t\t\t\t\treturn;\n'
const priorRobustCase = catalogCase.replace(
  'if (this.listInflight !== null) await this.listInflight;\n\t\t\t\t\t\t\t\t\t\t\tthis.xhCatalogRefreshRequested = false;',
  'this.xhCatalogRefreshRequested = false;\n\t\t\t\t\t\t\t\t\t\t\tif (this.listInflight !== null) await this.listInflight;',
)
const initialDraft = '\t\t\t\t\tcase "host/session-catalog-batch":\n\t\t\t\t\t\tvoid this.refreshList();\n\t\t\t\t\t\treturn;\n'

export function patchStartupCatalogRefresh(bytes) {
  const source = bytes.toString('utf8')
  if (source.includes(catalogCase)) return bytes
  if (source.includes(priorRobustCase)) return Buffer.from(source.replace(priorRobustCase, catalogCase))
  if (source.includes(priorSimpleCase)) return Buffer.from(source.replace(priorSimpleCase, catalogCase))
  if (source.includes(initialDraft)) return Buffer.from(source.replace(initialDraft, catalogCase))
  if (source.split(caseAnchor).length !== 2) {
    throw Error('SessionManager host/session-added anchor changed')
  }
  return Buffer.from(source.replace(caseAnchor, catalogCase + caseAnchor))
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = resolve(process.argv[2] ?? 'ui/dist')
  const graphPath = resolve(dist, 'client-graph.json')
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'))
  const id = '@xharness/dsh-client-runtime'
  const entry = graph.entries.find(row => row.id === id)
  if (!entry) throw Error('runtime plugin missing')
  const path = resolve(dist, 'plugins', id, 'client.js')
  const bytes = patchStartupCatalogRefresh(readFileSync(path))
  writeFileSync(path, bytes)
  const hash = input => createHash('sha256').update(input).digest('hex').slice(0, 16)
  entry.rev = hash(bytes)
  entry.url = `/plugins/${id}/client.js?rev=${entry.rev}`
  graph.rev = hash(JSON.stringify(graph.entries))
  writeFileSync(graphPath, JSON.stringify(graph, null, 2) + '\n')
  const index = resolve(dist, 'index.html')
  const tag = new RegExp(`/plugins/${id.replaceAll('.', '\\.')}/client\\.js\\?rev=[0-9a-f]+`, 'g')
  writeFileSync(index, readFileSync(index, 'utf8')
    .replace(tag, entry.url)
    .replace(/window\.__DSH_BOOT__ = .*?<\/script>/, () => `window.__DSH_BOOT__ = ${JSON.stringify(graph)}</script>`))
}
