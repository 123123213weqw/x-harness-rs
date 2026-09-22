// Refresh only the product Computer Use UI; do not rebuild unrelated upstream UI.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UI_NAMESPACE } from './ui-namespace.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const dist = resolve(process.argv[2] ?? resolve(root, 'ui/dist'))
const id = '@xlang/xharness-client-ui-computer'
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16)
const source = readFileSync(resolve(root, `ui/plugins/${id}/client.js`), 'utf8').replaceAll('\r\n', '\n')
const graphPath = resolve(dist, 'client-graph.json')
const graph = JSON.parse(readFileSync(graphPath, 'utf8'))
const inject = [`${UI_NAMESPACE}/dsh-client-ui-tool`, `${UI_NAMESPACE}/dsh-client-locale`]
for (const dependency of inject) {
  if (!graph.entries.some(entry => entry.id === dependency)) throw Error(`missing dependency ${dependency}`)
}
const rev = hash(source)
graph.entries = graph.entries.filter(entry => entry.id !== id)
const lastDependency = Math.max(...inject.map(dependency => graph.entries.findIndex(entry => entry.id === dependency)))
graph.entries.splice(lastDependency + 1, 0, {
  id,
  url: `/plugins/${id}/client.js?rev=${rev}`,
  rev,
  inject,
})
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
console.log(`computer UI plugin synchronized (${rev})`)
