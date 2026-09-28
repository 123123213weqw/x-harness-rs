#!/usr/bin/env node
// Remove inherited product copy while preserving real provider/model names.
// Applied to upstream-named bundles before namespace rewriting and to the
// checked-in dist by the CLI entry point below.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const hash = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 16)

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source
  const at = source.indexOf(before)
  if (at < 0 || source.indexOf(before, at + before.length) >= 0) {
    throw new Error(`product brand copy: expected one ${label} anchor`)
  }
  return source.slice(0, at) + after + source.slice(at + before.length)
}

export function patchProductBrandCopy(id, input) {
  let source = input.toString()
  if (id.endsWith('/dsh-client-ui-conversation')) {
    source = replaceOnce(source,
      'children: ["Deep diving...", showClock &&',
      'children: [t("xh.turn.working"), showClock &&',
      'turn status')
    source = replaceOnce(source,
      '"view.chat": "对话",',
      '"view.chat": "对话",\n\t\t\t"xh.turn.working": "正在处理…",',
      'Chinese turn status')
    source = replaceOnce(source,
      '"view.chat": "Chat",',
      '"view.chat": "Chat",\n\t\t\t"xh.turn.working": "Working…",',
      'English turn status')
    source = source
      .replaceAll('var(--dsw-static-deepseek-500)', 'var(--dsw-alias-label-secondary)')
      .replaceAll('var(--dsw-static-deepseek-200)', 'var(--dsw-alias-label-tertiary)')
  } else if (id.endsWith('/dsh-client-ui-sidebar')) {
    source = replaceOnce(source, 'children: "DSH Local Build"', 'children: "XHarness"', 'sidebar fallback')
  } else if (id.endsWith('/dsh-client-ui-settings-models')) {
    source = source.replace('// The upstream DeepSeek Harness welcome notice is not a product notice.', '// The upstream welcome notice is not a product notice.')
    source = replaceOnce(source,
      'onboardingDescription: "Configure the official DeepSeek provider to start building."',
      'onboardingDescription: "Add a provider API key to get started."',
      'English onboarding copy')
    source = replaceOnce(source,
      'onboardingDescription: "配置 DeepSeek 官方模型，即可开始使用。"',
      'onboardingDescription: "添加模型提供方的 API 密钥即可开始使用。"',
      'Chinese onboarding copy')
    const noticeBodies = [...source.matchAll(/\bbody: "DeepSeek Harness[^"\n]*"/g)]
    if (noticeBodies.length !== 0 && noticeBodies.length !== 2) {
      throw new Error('product brand copy: expected both upstream welcome notice bodies')
    }
    source = source.replaceAll(/\bbody: "DeepSeek Harness[^"\n]*"/g, 'body: ""')
    source = replaceOnce(source,
      'ctx.slots.inject("settings.onboarding", () => ctx.slots.register({\n\t\t\t\tname: "settings.onboarding",\n\t\t\t\tid: "welcome-notice",\n\t\t\t\torder: -100,\n\t\t\t\tinject: welcomeInjected\n\t\t\t}, WelcomeNotice));',
      '// The upstream welcome notice is not a product notice.',
      'upstream welcome notice')
    source = replaceOnce(source,
      'ctx.slots.inject("settings.onboarding", () => ctx.slots.register({\n\t\t\t\tname: "settings.onboarding",\n\t\t\t\tid: "deepseek-official",\n\t\t\t\torder: 0,\n\t\t\t\tinject: deepSeekOnboardingInjected\n\t\t\t}, DeepSeekOnboardingDialog));',
      '// Model providers are configured from Settings, not an upstream-specific first-run prompt.',
      'provider-specific onboarding')
  } else if (id.endsWith('/dsh-client-ui-settings-plugins')) {
    source = replaceOnce(source,
      'webSearchDescription: "The DeepSeek search provider."',
      'webSearchDescription: "Provider used for web search."',
      'English web search copy')
    source = replaceOnce(source,
      'webSearchDescription: "DeepSeek 搜索提供方。"',
      'webSearchDescription: "用于网页搜索的提供方。"',
      'Chinese web search copy')
  }
  return Buffer.from(source)
}

export function patchProductBrandDist(dist) {
  const graphPath = resolve(dist, 'client-graph.json')
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'))
  let html = readFileSync(resolve(dist, 'index.html'), 'utf8')
  const names = ['conversation', 'sidebar', 'settings-models', 'settings-plugins']
  for (const name of names) {
    const id = `@xharness/dsh-client-ui-${name}`
    const path = resolve(dist, 'plugins', id, 'client.js')
    const before = readFileSync(path)
    const after = patchProductBrandCopy(id, before)
    if (!after.equals(before)) writeFileSync(path, after)
    const entry = graph.entries.find(item => item.id === id)
    if (!entry) throw new Error(`product brand copy: missing graph entry ${id}`)
    const previousUrl = entry.url
    entry.rev = hash(after)
    entry.url = `/plugins/${id}/client.js?rev=${entry.rev}`
    html = html.replaceAll(previousUrl, entry.url)
  }
  graph.rev = hash(Buffer.from(JSON.stringify(graph.entries)))
  const boot = html.match(/window\.__DSH_BOOT__ = (.*?)<\/script>/)
  if (!boot) throw new Error('product brand copy: missing HTML boot graph')
  html = html.replace(boot[0], `window.__DSH_BOOT__ = ${JSON.stringify(graph)}</script>`)
  writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`)
  writeFileSync(resolve(dist, 'index.html'), html)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  patchProductBrandDist(resolve(process.argv[2] ?? 'ui/dist'))
}
