// Refresh the checked-in desktop/browser UI without rebuilding upstream bundles.
// Fresh releases use assemble-static-ui.mjs, which applies the same patch.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { patchBrowserDock } from './patch-browser-dock.mjs'
import { UI_NAMESPACE } from './ui-namespace.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const dist = resolve(process.argv[2] ?? resolve(root, 'ui/dist'))
const id = '@xlang/xharness-client-ui-browser'
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16)
const source = readFileSync(resolve(root, `ui/plugins/${id}/client.js`))
const graphPath = resolve(dist, 'client-graph.json')
const graph = JSON.parse(readFileSync(graphPath, 'utf8'))
const layoutId = `${UI_NAMESPACE}/dsh-client-ui-layout`
const layoutEntry = graph.entries.find(entry => entry.id === layoutId)
if (!layoutEntry) throw Error('missing layout plugin')
const layoutPath = resolve(dist, `plugins/${layoutId}/client.js`)
const layout = patchBrowserDock(readFileSync(layoutPath))
writeFileSync(layoutPath, layout)
layoutEntry.rev = hash(layout)
layoutEntry.url = `/plugins/${layoutId}/client.js?rev=${layoutEntry.rev}`
// Browser shortcuts use terminal-owned stable markers, so ship both contracts together.
const terminalId = '@xlang/xharness-client-ui-terminal'
const terminalEntry = graph.entries.find(entry => entry.id === terminalId)
if (terminalEntry) {
  const terminal = readFileSync(resolve(root, `ui/plugins/${terminalId}/client.js`))
  writeFileSync(resolve(dist, `plugins/${terminalId}/client.js`), terminal)
  terminalEntry.rev = hash(terminal)
  terminalEntry.url = `/plugins/${terminalId}/client.js?rev=${terminalEntry.rev}`
}
const inject = [`${UI_NAMESPACE}/dsh-client-runtime`, layoutId, `${UI_NAMESPACE}/dsh-client-ui-conversation`]
const rev = hash(source)
graph.entries = graph.entries.filter(entry => entry.id !== id)
const dependencies = inject.map(dependency => graph.entries.findIndex(entry => entry.id === dependency))
if (dependencies.some(index => index < 0)) throw Error('missing browser dependency')
graph.entries.splice(Math.max(...dependencies) + 1, 0, {
  id, url: `/plugins/${id}/client.js?rev=${rev}`, rev, inject,
})
graph.rev = hash(JSON.stringify(graph.entries))
const target = resolve(dist, `plugins/${id}/client.js`)
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, source)
const indexPath = resolve(dist, 'index.html')
const html = readFileSync(indexPath, 'utf8')
const pattern = /window\.__DSH_BOOT__ = .*?<\/script>/
if (!pattern.test(html)) throw Error('missing boot graph')
writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`)
writeFileSync(indexPath, html.replace(pattern, () => `window.__DSH_BOOT__ = ${JSON.stringify(graph)}</script>`))
console.log(`desktop browser UI synchronized (layout ${layoutEntry.rev}, browser ${rev})`)
