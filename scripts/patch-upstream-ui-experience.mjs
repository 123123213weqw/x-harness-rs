// Selective, fail-closed backport from DeepSeek Harness dsh-v0.1.7-rc.2.
// Keep the existing XHarness Host protocol: only presentation is patched.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const reviewSource = readFileSync(resolve(root, 'ui/overrides/review-diff.js'), 'utf8')
const processMode = readFileSync(resolve(root, 'ui/overrides/process-mode-hook.js'), 'utf8')
const marker = '// XHARNESS UPSTREAM UI EXPERIENCE 0.1.7-rc.2'
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16)

function once(text, from, to, label) {
  if (text.split(from).length !== 2) throw new Error(`upstream UI ${label} signature changed: ${from.slice(0, 85)}`)
  return text.replace(from, to)
}
function finish(text) { return Buffer.from(text.replace(/\n\/\/# sourceMappingURL=client\.js\.map\s*$/, '').trimEnd() + '\n') }

export function patchToolExperience(bytes) {
  let text = bytes.toString('utf8')
  const rawNamespace = text.includes('_deepseek_ai_dsh_client_ui_primitives')
  const review = rawNamespace ? reviewSource.replaceAll('_xharness_dsh_client_ui_primitives', '_deepseek_ai_dsh_client_ui_primitives') : reviewSource
  if (text.includes(marker)) {
    const start = text.indexOf(marker) + marker.length + 1
    const end = text.indexOf('\t\tfunction xhWebHref(', start)
    if (end < 0) throw new Error('upstream UI tool backport marker is incomplete')
    return finish(text.slice(0, start) + processMode + '\n' + review + '\n' + text.slice(end))
  }
  text = once(text, '\t\tfunction ToolRow({ t, variant, toolName, icon, title, summary, summarySuffix, body, output, errorSummary, terminal, diff, read, search, web, state, filePath, onOpenFile, inspect }) {',
    `\t\t${marker}\n${processMode}\n${review}\n\t\tfunction xhWebHref(toolName, summary) {\n\t\t\tif (toolName !== "web_fetch") return null;\n\t\t\ttry { const url = new URL(summary); return url.protocol === "http:" || url.protocol === "https:" ? url.href : null; } catch { return null; }\n\t\t}\n\t\tfunction ToolRow({ t, variant, toolName, icon, title, summary, summarySuffix, body, output, errorSummary, terminal, diff, read, search, web, state, filePath, onOpenFile, inspect }) {`, 'tool row')
  text = once(text, 'const [expanded, setExpanded] = (0, react.useState)(false);\n\t\t\tconst terminalBody',
    `const [expanded, setExpanded] = (0, react.useState)(false);\n\t\t\tconst processMode = xhUseProcessMode();\n\t\t\t(0, react.useEffect)(() => {\n\t\t\t\tif (processMode === "verbose") setExpanded(true);\n\t\t\t\telse if (processMode === "compact") setExpanded(false);\n\t\t\t\telse if (processMode === "detailed" && (state === "running" || state === "preparing") && (body?.length ?? 0) < 4096) setExpanded(true);\n\t\t\t}, [processMode, state]);\n\t\t\tconst terminalBody`, 'process mode in tool')
  text = once(text, 'const summaryText = failureLine ?? summary;\n\t\t\tconst suffix',
    'const summaryText = failureLine ?? summary;\n\t\t\tconst webHref = failureLine === null ? xhWebHref(toolName, summaryText) : null;\n\t\t\tconst suffix', 'web href')
  text = once(text, '}) : (0, react_jsx_runtime.jsx)("span", {\n\t\t\t\t\t\t\tclassName: clsx(ToolRow_module_css_default.summary, failureLine !== null && ToolRow_module_css_default.errorSummary),\n\t\t\t\t\t\t\tchildren: summaryText\n\t\t\t\t\t\t}),',
    `}) : webHref !== null ? (0, react_jsx_runtime.jsx)("a", {\n\t\t\t\t\t\t\tclassName: ToolRow_module_css_default.fileLink, href: webHref, target: "_blank", rel: "noopener noreferrer",\n\t\t\t\t\t\t\tonClick: event => event.stopPropagation(), onKeyDown: event => event.stopPropagation(),\n\t\t\t\t\t\t\tchildren: summaryText\n\t\t\t\t\t\t}) : (0, react_jsx_runtime.jsx)("span", {\n\t\t\t\t\t\t\tclassName: clsx(ToolRow_module_css_default.summary, failureLine !== null && ToolRow_module_css_default.errorSummary),\n\t\t\t\t\t\t\tchildren: summaryText\n\t\t\t\t\t\t\t}),`, 'web link')
  text = once(text, 'const state = !done ? "running" : block.error?.code',
    'const state = !done ? argsRaw === "" ? "preparing" : "running" : block.error?.code', 'preparing state')
  text = once(text, 'const base = argsRaw === "" ? block.callId :',
    'const base = argsRaw === "" ? "" :', 'preparing summary')
  text = once(text, 'case "running": return t("row.running");',
    'case "preparing": return t("row.running");\n\t\t\t\tcase "running": return t("row.running");', 'preparing a11y')
  text = once(text, 'title,\n\t\t\t\t\topen,\n\t\t\t\t\texpandable,',
    'title: state === "preparing" ? `${title} · ${(document.documentElement.lang || "").startsWith("zh") ? "准备中" : "Preparing"}` : title,\n\t\t\t\t\topen,\n\t\t\t\t\texpandable,', 'preparing label')
  const diffCall = `(0, react_jsx_runtime.jsx)(_${rawNamespace ? 'deepseek_ai' : 'xharness'}_dsh_client_ui_primitives.DiffBlock, {`
  if (text.split(diffCall).length !== 3) throw new Error('upstream UI diff call count changed')
  text = text.replaceAll(diffCall, '(0, react_jsx_runtime.jsx)(XHReviewDiffBlock, {')
  return finish(text)
}

export function patchConversationExperience(bytes) {
  let text = bytes.toString('utf8')
  if (text.includes(marker)) {
    const start = text.indexOf(marker) + marker.length + 1
    const end = text.indexOf('\t\tfunction ReasoningRow(', start)
    if (end < 0) throw new Error('upstream UI conversation backport marker is incomplete')
    return finish(patchPreparingCall(text.slice(0, start) + processMode + '\n' + text.slice(end)))
  }
  text = once(text, '\t\tfunction ReasoningRow({ text, running, t }) {',
    `\t\t${marker}\n${processMode}\n\t\tfunction ReasoningRow({ text, running, t }) {`, 'reasoning row')
  text = once(text, 'function ReasoningRow({ text, running, t }) {\n\t\t\tconst [expanded, setExpanded] = (0, react.useState)(false);',
    `function ReasoningRow({ text, running, t }) {\n\t\t\tconst [expanded, setExpanded] = (0, react.useState)(false);\n\t\t\tconst processMode = xhUseProcessMode();\n\t\t\t(0, react.useEffect)(() => {\n\t\t\t\tif (processMode === "verbose") setExpanded(true);\n\t\t\t\telse if (processMode === "compact") setExpanded(false);\n\t\t\t\telse if (processMode === "detailed" && running && text.length < 8192) setExpanded(true);\n\t\t\t}, [processMode, running]);`, 'reasoning mode')
  return finish(patchPreparingCall(text))
}

function patchPreparingCall(text) {
  // Assistant tool-call deltas exist in the old projection but were invisible.
  // Surface a transient preparation row only while arguments are incomplete.
  // A dispatched/settled call remains owned by the existing ToolRow, avoiding
  // duplicate cards in history and never exposing partial JSON to the UI.
  const helper = `\t\tfunction xhPreparingCall(block) {
\t\t\tif (block.kind !== "tool-call" || !block.name) return false;
\t\t\tif (!block.argsRaw || block.argsRaw.length > 8192) return true;
\t\t\ttry { const value = JSON.parse(block.argsRaw); return value === null || typeof value !== "object" || Array.isArray(value); }
\t\t\tcatch { return true; }
\t\t}
`
  if (text.includes('function xhPreparingCall(')) {
    const start = text.indexOf('\t\tfunction xhPreparingCall(')
    const end = text.indexOf('\t\tconst AssistantMarkdown = (0, react.memo)', start)
    if (end < 0) throw new Error('streaming tool preparation helper is incomplete')
    return text.slice(0, start) + helper + text.slice(end)
  }
  text = once(text, '\t\tconst AssistantMarkdown = (0, react.memo)(function AssistantMarkdown(', `${helper}\t\tconst AssistantMarkdown = (0, react.memo)(function AssistantMarkdown(`, 'streaming tool preparation helper')
  text = once(text, '\t\t\t\t\tcase "tool-call": break;', `\t\t\t\t\tcase "tool-call":
\t\t\t\t\t\tif (streaming && xhPreparingCall(block)) rendered.push((0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\t\t\tclassName: "xh-tool-preparing", role: "status", "aria-live": "polite",
\t\t\t\t\t\t\tchildren: [(document.documentElement.lang || "").startsWith("zh") ? "准备工具" : "Preparing tool", " · ", block.name]
\t\t\t\t\t\t}, i));
\t\t\t\t\t\tbreak;`, 'render transient tool preparation')
  text = once(text, '\t\t\tconst visible = hasVisibleContent(blocks);\n\t\t\tconst status = settled?.interrupted',
    '\t\t\tconst visible = hasVisibleContent(blocks) || settled === void 0 && blocks.some(xhPreparingCall);\n\t\t\tconst status = settled?.interrupted', 'show streamed preparation')
  return text
}

export function patchModelSwitchProgress(bytes) {
  let text = bytes.toString('utf8')
  if (text.includes(marker)) return bytes
  const namespace = text.includes('_deepseek_ai_dsh_client_ui_primitives') ? 'deepseek_ai' : 'xharness'
  text = once(text, '\t\tfunction ModelSelect({ locked, available, directory, load, select, t }) {',
    `\t\t${marker}\n\t\tfunction ModelSelect({ locked, available, directory, load, select, t }) {`, 'model selection')
  text = once(text, '\t\t\t\t\t\ttitle: triggerLabel,\n\t\t\t\t\t\tdisabled: locked,',
    '\t\t\t\t\t\ttitle: triggerLabel,\n\t\t\t\t\t\t"aria-busy": busy || void 0,\n\t\t\t\t\t\tdisabled: locked,', 'model busy')
  text = once(text, `\t\t\t\t\t\t\t(0, react_jsx_runtime.jsx)(_${namespace}_dsh_client_ui_primitives.IconChevronDownOutline14,`,
    `\t\t\t\t\t\t\tbusy ? (0, react_jsx_runtime.jsx)("span", { role: "status", "aria-live": "polite", className: "xh-model-switching", children: (document.documentElement.lang || "").startsWith("zh") ? "切换中…" : "Switching…" }) : null,\n\t\t\t\t\t\t\t(0, react_jsx_runtime.jsx)(_${namespace}_dsh_client_ui_primitives.IconChevronDownOutline14,`, 'model progress')
  // The menu already remains mounted while the RPC settles.  Keep the status
  // visible even when the user switches panes during the pending request.
  text = once(text, 'children: [\n\t\t\t\t\t\t\tpane === "root"',
    'children: [\n\t\t\t\t\t\t\tbusy && (0, react_jsx_runtime.jsx)("div", { role: "status", "aria-live": "polite", className: ModelSelect_module_css_default.status, children: (document.documentElement.lang || "").startsWith("zh") ? "正在切换模型…" : "Switching model…" }),\n\t\t\t\t\t\t\tpane === "root"', 'model menu progress')
  return finish(text)
}

export function refreshUpstreamUiExperience(dist) {
  const graphPath = resolve(dist, 'client-graph.json')
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'))
  for (const [id, patch] of [
    ['@xharness/dsh-client-ui-tool', patchToolExperience],
    ['@xharness/dsh-client-ui-conversation', patchConversationExperience],
    ['@xharness/dsh-client-ui-model-selection', patchModelSwitchProgress],
  ]) {
    const path = resolve(dist, `plugins/${id}/client.js`)
    const bytes = patch(readFileSync(path))
    const entry = graph.entries.find(value => value.id === id)
    if (!entry) throw new Error(`missing UI graph entry ${id}`)
    writeFileSync(path, bytes)
    entry.rev = hash(bytes)
    entry.url = `/plugins/${id}/client.js?rev=${entry.rev}`
  }
  const productId = '@xlang/xharness-client-ui-experience'
  const source = readFileSync(resolve(root, `ui/plugins/${productId}/client.js`))
  const productPath = resolve(dist, `plugins/${productId}/client.js`)
  mkdirSync(dirname(productPath), { recursive: true })
  writeFileSync(productPath, source)
  const inject = ['@xharness/dsh-client-locale', '@xharness/dsh-client-ui-settings']
  for (const id of inject) if (!graph.entries.some(value => value.id === id)) throw new Error(`missing UI dependency ${id}`)
  graph.entries = graph.entries.filter(value => value.id !== productId)
  const after = Math.max(...inject.map(id => graph.entries.findIndex(value => value.id === id)))
  const rev = hash(source)
  graph.entries.splice(after + 1, 0, { id: productId, url: `/plugins/${productId}/client.js?rev=${rev}`, rev, inject })
  graph.rev = hash(JSON.stringify(graph.entries))
  writeFileSync(graphPath, JSON.stringify(graph, null, 2) + '\n')
  const indexPath = resolve(dist, 'index.html')
  const html = readFileSync(indexPath, 'utf8')
  const signature = /window\.__DSH_BOOT__ = .*?<\/script>/
  if (!signature.test(html)) throw new Error('UI boot graph not found')
  writeFileSync(indexPath, html.replace(signature, () => `window.__DSH_BOOT__ = ${JSON.stringify(graph)}</script>`))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  refreshUpstreamUiExperience(resolve(process.argv[2] ?? resolve(root, 'ui/dist')))
}
