#!/usr/bin/env node
// Update only the product-owned Profile asset in an existing static UI bundle.
// Full releases use assemble-static-ui.mjs; this is for local Web preview.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const dist = resolve(process.argv[2] ?? 'ui/dist')
const id = '@xlang/xharness-client-ui-profile'
const bytes = readFileSync(new URL(`../ui/plugins/${id}/client.js`, import.meta.url))
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16)
const graphPath = `${dist}/client-graph.json`
const indexPath = `${dist}/index.html`
const graph = JSON.parse(readFileSync(graphPath, 'utf8'))
const prefix = graph.entries.some(entry => entry.id === '@xharness/dsh-client-ui-settings-general')
  ? '@xharness' : '@deepseek-ai'
if (!graph.entries.some(entry => entry.id === `${prefix}/dsh-client-ui-settings-general`)) {
  throw new Error('settings.section owner is missing from static UI graph')
}
const entry = {
  id,
  url: `/plugins/${id}/client.js?rev=${hash(bytes)}`,
  rev: hash(bytes),
  inject: [
    `${prefix}/dsh-client-runtime`,
    `${prefix}/dsh-client-locale`,
    `${prefix}/dsh-client-ui-settings-general`,
  ],
}
graph.entries = graph.entries.filter(previous => previous.id !== id)
graph.entries.push(entry)
graph.rev = hash(JSON.stringify(graph.entries))
const html = readFileSync(indexPath, 'utf8')
const boot = /window\.__DSH_BOOT__ = .*?<\/script>/
if (!boot.test(html)) throw new Error('static UI boot graph is missing')
const target = `${dist}/plugins/${id}/client.js`
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, bytes)
writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`)
writeFileSync(indexPath, html.replace(boot, () => `window.__DSH_BOOT__ = ${JSON.stringify(graph)}</script>`))
console.log(`Profile ${entry.rev} refreshed in ${dist}`)
