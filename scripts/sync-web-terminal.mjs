// Refresh the product-owned terminal plugin without rebuilding unrelated UI.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const dist = resolve(process.argv[2] ?? resolve(root, 'ui/dist'))
const id = '@xlang/xharness-client-ui-terminal'
const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 16)
const source = readFileSync(resolve(root, `ui/plugins/${id}/client.js`), 'utf8')
const graphPath = resolve(dist, 'client-graph.json')
const graph = JSON.parse(readFileSync(graphPath, 'utf8'))
const entry = graph.entries.find((candidate) => candidate.id === id)
if (!entry) throw new Error(`${id} is missing from the shipped client graph`)

const rev = hash(source)
entry.rev = rev
entry.url = `/plugins/${id}/client.js?rev=${rev}`
graph.rev = hash(JSON.stringify(graph.entries))

const indexPath = resolve(dist, 'index.html')
const html = readFileSync(indexPath, 'utf8')
const boot = /window\.__DSH_BOOT__ = .*?<\/script>/
if (!boot.test(html)) throw new Error('missing boot graph in index.html')

const target = resolve(dist, `plugins/${id}/client.js`)
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, source)
writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`)
writeFileSync(indexPath, html.replace(boot, () => `window.__DSH_BOOT__ = ${JSON.stringify(graph)}</script>`))
console.log(`terminal plugin synchronized (${rev})`)
