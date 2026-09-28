#!/usr/bin/env node
// Hide the upstream agent-preset chooser and settings surfaces. The Host still
// chooses its configured default for new sessions and retains existing presets.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const hash = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 16)

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source
  const at = source.indexOf(before)
  if (at < 0 || source.indexOf(before, at + before.length) >= 0) {
    throw new Error(`agent preset UI: expected one ${label} anchor`)
  }
  return source.slice(0, at) + after + source.slice(at + before.length)
}

export function patchAgentPresetUi(id, input) {
  if (!id.endsWith('/dsh-client-ui-agent-preset')) return input
  let source = input.toString()
  source = replaceOnce(source,
    `const chip = scope.slots.register({
						name: "conversation.hero.agentPreset",
						locale: "settings.agentPreset",
						inject: seatInjected
					}, AgentPresetSeat);`,
    '// The default agent is selected by the Host; no hero mode chooser.',
    'hero chooser')
  source = replaceOnce(source,
    `const label = scope.slots.register({
						name: "conversation.session.header.actions",
						id: "agent-preset",
						order: -10,
						locale: "settings.agentPreset",
						inject: labelInjected
					}, AgentPresetLabel);`,
    '// Agent preset is runtime state, not a persistent header control.',
    'session header label')
  source = replaceOnce(source,
    '\t\t\t\t\t\tchip();\n\t\t\t\t\t\tlabel();',
    '\t\t\t\t\t\t// No agent-preset UI slots to dispose.',
    'slot cleanup')
  source = replaceOnce(source,
    `ctx.slots.inject("settings.general.item", () => ctx.slots.register({
				name: "settings.general.item",
				id: "agent-preset",
				order: -25,
				locale: "settings.agentPreset",
				inject: injected
			}, AgentPresetRow));`,
    '// No agent-preset row in General settings.',
    'General settings row')
  source = replaceOnce(source,
    `ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "agent-presets",
				order: 20,
				label: () => ctx.locale.bind("settings.agentPreset")("nav"),
				locale: "settings.agentPreset",
				inject: sectionInjected
			}, AgentPresetSection));`,
    '// No dedicated Agent presets settings page.',
    'Settings section')
  return Buffer.from(source)
}

export function patchAgentPresetDist(dist) {
  const id = '@xharness/dsh-client-ui-agent-preset'
  const path = resolve(dist, 'plugins', id, 'client.js')
  const before = readFileSync(path)
  const after = patchAgentPresetUi(id, before)
  if (!after.equals(before)) writeFileSync(path, after)

  const graphPath = resolve(dist, 'client-graph.json')
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'))
  const entry = graph.entries.find(item => item.id === id)
  if (!entry) throw new Error(`agent preset UI: missing graph entry ${id}`)
  entry.rev = hash(after)
  entry.url = `/plugins/${id}/client.js?rev=${entry.rev}`
  graph.rev = hash(Buffer.from(JSON.stringify(graph.entries)))

  const htmlPath = resolve(dist, 'index.html')
  let html = readFileSync(htmlPath, 'utf8')
  const boot = html.match(/window\.__DSH_BOOT__ = (.*?)<\/script>/)
  if (!boot) throw new Error('agent preset UI: missing HTML boot graph')
  html = html.replace(boot[0], `window.__DSH_BOOT__ = ${JSON.stringify(graph)}</script>`)
  writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`)
  writeFileSync(htmlPath, html)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  patchAgentPresetDist(resolve(process.argv[2] ?? 'ui/dist'))
}
