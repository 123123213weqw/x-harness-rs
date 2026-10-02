import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { patchProductBrandCopy } from './patch-product-brand-copy.mjs'

const dist = resolve('ui/dist')
const graph = JSON.parse(readFileSync(resolve(dist, 'client-graph.json'), 'utf8'))
const html = readFileSync(resolve(dist, 'index.html'), 'utf8')
const hash = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 16)
assert.equal(graph.rev, hash(Buffer.from(JSON.stringify(graph.entries))))
assert.match(html, new RegExp(`"rev":"${graph.rev}"`))
const get = name => {
  const id = `@xharness/dsh-client-ui-${name}`
  const bytes = readFileSync(resolve(dist, 'plugins', id, 'client.js'))
  const entry = graph.entries.find(item => item.id === id)
  assert.equal(entry.rev, hash(bytes))
  assert.equal(patchProductBrandCopy(id, bytes).toString(), bytes.toString(), `${name} patch is repeatable`)
  return bytes.toString()
}
const conversation = get('conversation')
assert.match(conversation, /"xh\.turn\.working": "正在处理…"/)
assert.match(conversation, /"xh\.turn\.working": "Working…"/)
assert.match(conversation, /children: \[t\("xh\.turn\.working"\), showClock/)
assert.doesNotMatch(conversation, /Deep diving|dsw-static-deepseek/)
const sidebar = get('sidebar')
assert.match(sidebar, /children: "XHarness"/)
assert.doesNotMatch(sidebar, /DSH Local Build/)
const models = get('settings-models')
assert.doesNotMatch(models, /ctx\.slots\.inject\("settings\.onboarding"/, 'neither upstream first-run screen is registered')
assert.doesNotMatch(models, /DeepSeek Harness 0\.1|DSH 插件生态|Configure the official DeepSeek provider|配置 DeepSeek 官方模型/)
assert.match(models, /deepseek-official/, 'real model provider remains available')
const settings = get('settings-plugins')
assert.doesNotMatch(settings, /The DeepSeek search provider|DeepSeek 搜索提供方/)
assert.match(settings, /Provider used for web search/)
const { assertRebuildInput } = await import('./fixtures/repository-ui-input.mjs')
for (const name of ['conversation', 'sidebar', 'settings-models', 'settings-plugins']) assertRebuildInput(`@xharness/dsh-client-ui-${name}`)
console.log('product brand copy: running status, welcome, onboarding, fallback, search, rebuild and graph passed')
