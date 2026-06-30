// Refresh only the product directory plugin; do not rebuild unrelated upstream UI.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UI_NAMESPACE } from './ui-namespace.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
const dist = resolve(process.argv[2] ?? resolve(root, 'ui/dist'))
const id = '@xlang/xharness-client-ui-tasks'
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16)
const source = readFileSync(resolve(root, `ui/plugins/${id}/client.js`), 'utf8').replaceAll('\r\n', '\n')
const graphPath = resolve(dist, 'client-graph.json')
const graph = JSON.parse(readFileSync(graphPath, 'utf8'))
const inject = [`${UI_NAMESPACE}/dsh-client-runtime`, `${UI_NAMESPACE}/dsh-client-locale`, `${UI_NAMESPACE}/dsh-client-ui-conversation`, `${UI_NAMESPACE}/dsh-client-ui-primitives`]
for (const dep of inject.filter(id => !id.endsWith('/dsh-client-ui-primitives'))) {
  if (!graph.entries.some(e => e.id === dep)) throw Error(`missing dependency ${dep}`)
}
const rev = hash(source)
const entry = graph.entries.find(entry => entry.id === id)
if (!entry) throw Error(`missing ${id} in graph`)
entry.url = `/plugins/${id}/client.js?rev=${rev}`
entry.rev = rev
entry.inject = inject
graph.rev = hash(JSON.stringify(graph.entries))
const indexPath = resolve(dist, 'index.html')
const html = readFileSync(indexPath, 'utf8')
const pattern = /window\.__DSH_BOOT__ = .*?<\/script>/
if (!pattern.test(html)) throw Error('missing boot graph')
const target = resolve(dist, `plugins/${id}/client.js`)
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, source)
writeFileSync(graphPath, JSON.stringify(graph, null, 2) + '\n')
writeFileSync(indexPath, html.replace(pattern, () => `window.__DSH_BOOT__ = ${JSON.stringify(graph)}</script>`))
console.log(`tasks plugin synchronized (${rev})`)
