#!/usr/bin/env node
// Update an already-assembled UI without rebuilding the vendored upstream.
// Fresh builds use assemble-static-ui.mjs and its productPlugins graph instead.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = resolve(process.argv[2] ?? resolve(root, 'ui/dist'))
const rev = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 16)
const graphPath = resolve(dist, 'client-graph.json')
const graph = JSON.parse(readFileSync(graphPath, 'utf8'))
const settingsId = '@xharness/dsh-client-ui-settings-plugins'
const hubId = '@xlang/xharness-client-ui-plugin-hub'
const settingsPath = resolve(dist, 'plugins', settingsId, 'client.js')
const hubPath = resolve(dist, 'plugins', hubId, 'client.js')
let settings = readFileSync(settingsPath, 'utf8')
const old = 'ctx.slots.inject("plugins.center", () => ctx.slots.register({\n\t\t\t\tname: "plugins.center",\n\t\t\t\tid: "plugins",'
const next = 'ctx.slots.inject("plugins.advanced", () => ctx.slots.register({\n\t\t\t\tname: "plugins.advanced",\n\t\t\t\tid: "plugins",'
if (!settings.includes(next)) {
  if (!settings.includes(old)) throw new Error('existing plugin settings anchor not found')
  settings = settings.replace(old, next)
  writeFileSync(settingsPath, settings)
}
const hub = readFileSync(resolve(root, 'ui/plugins/@xlang/xharness-client-ui-plugin-hub/client.js'))
mkdirSync(dirname(hubPath), { recursive: true })
writeFileSync(hubPath, hub)
const settingsEntry = graph.entries.find(entry => entry.id === settingsId)
if (!settingsEntry) throw new Error(`missing ${settingsId}`)
settingsEntry.rev = rev(Buffer.from(settings))
settingsEntry.url = `/plugins/${settingsId}/client.js?rev=${settingsEntry.rev}`
let hubEntry = graph.entries.find(entry => entry.id === hubId)
if (!hubEntry) {
  hubEntry = { id: hubId, url: '', rev: '', inject: [
    '@xharness/dsh-client-runtime', '@xharness/dsh-client-locale',
    '@xharness/dsh-client-ui-layout', settingsId,
  ] }
  graph.entries.push(hubEntry)
}
hubEntry.rev = rev(hub)
hubEntry.url = `/plugins/${hubId}/client.js?rev=${hubEntry.rev}`
graph.rev = rev(Buffer.from(JSON.stringify(graph.entries)))
const indexPath = resolve(dist, 'index.html')
const html = readFileSync(indexPath, 'utf8')
const boot = html.match(/window\.__DSH_BOOT__ = (.*?)<\/script>/)
if (!boot) throw new Error('missing boot graph')
writeFileSync(indexPath, html.replace(boot[0], `window.__DSH_BOOT__ = ${JSON.stringify(graph)}</script>`))
writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`)
console.log(`plugin hub dist updated: ${graph.rev}`)
