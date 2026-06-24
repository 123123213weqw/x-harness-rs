#!/usr/bin/env node
// Move the upstream Plugins settings section into a first-class center page.
// Keep the patch here so rebuilding the vendored UI cannot restore the old nav.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ids = {
  layout: '@xharness/dsh-client-ui-layout',
  workspace: '@xharness/dsh-client-ui-workspace',
  settings: '@xharness/dsh-client-ui-settings-plugins',
}

function replaceOnce(source, oldText, newText, label) {
  if (source.includes(newText)) return source
  const first = source.indexOf(oldText)
  if (first < 0 || source.indexOf(oldText, first + oldText.length) >= 0) {
    throw new Error(`plugin center: expected one ${label} anchor`)
  }
  return source.slice(0, first) + newText + source.slice(first + oldText.length)
}

export function patchPluginCenterLayout(input) {
  let source = input.toString()
  source = replaceOnce(source,
    '\t\t\tconst frameRef = (0, react.useRef)(null);',
    `\t\t\tconst frameRef = (0, react.useRef)(null);
\t\t\tconst [pluginCenterOpen, setPluginCenterOpen] = (0, react.useState)(false);
\t\t\tconst closePluginCenter = () => {
\t\t\t\tsetPluginCenterOpen(false);
\t\t\t\twindow.dispatchEvent(new Event("xharness:plugins:closed"));
\t\t\t};
\t\t\t(0, react.useEffect)(() => {
\t\t\t\tconst open = () => setPluginCenterOpen(true);
\t\t\t\twindow.addEventListener("xharness:plugins:open", open);
\t\t\t\treturn () => window.removeEventListener("xharness:plugins:open", open);
\t\t\t}, []);`,
    'layout view state')
  source = replaceOnce(source,
    'children: renderSlot("sidebar", {\n\t\t\t\t\t\t\tcollapsed: sidebarCollapsed,',
    `onClickCapture: (event) => {
\t\t\t\t\t\t\tif (pluginCenterOpen && !event.target.closest?.("[data-xharness-plugin-nav]")) closePluginCenter();
\t\t\t\t\t\t},
\t\t\t\t\t\tchildren: renderSlot("sidebar", {
\t\t\t\t\t\t\tcollapsed: sidebarCollapsed,`,
    'sidebar navigation close')
  source = replaceOnce(source,
    '(0, react_jsx_runtime.jsx)(CenterColumn, { children: renderSlot("conversation", {}) })',
    `(0, react_jsx_runtime.jsx)(CenterColumn, { children: pluginCenterOpen ? (0, react_jsx_runtime.jsxs)("main", {
\t\t\t\t\t\t\tstyle: { flex: 1, minHeight: 0, overflowY: "auto", padding: "24px clamp(20px, 5vw, 56px)" },
\t\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("button", {
\t\t\t\t\t\t\t\ttype: "button",
\t\t\t\t\t\t\t\tstyle: { cursor: "pointer", background: "none", border: 0, color: "var(--dsw-alias-label-secondary)", padding: "0 0 24px", font: "inherit" },
\t\t\t\t\t\t\t\t"aria-label": "Back to chat",
\t\t\t\t\t\t\t\tonClick: closePluginCenter,
\t\t\t\t\t\t\t\tchildren: "← " + (navigator.language.startsWith("zh") ? "返回对话" : "Back to chat")
\t\t\t\t\t\t\t}), renderSlot("plugins.center", {})]
\t\t\t\t\t\t}) : renderSlot("conversation", {}) })`,
    'center page')
  source = replaceOnce(source,
    '"conversation": {\n\t\t\t\t\t\t\tkind: "single",\n\t\t\t\t\t\t\tscope: "session-maybe"\n\t\t\t\t\t\t},',
    `"conversation": {
\t\t\t\t\t\t\tkind: "single",
\t\t\t\t\t\t\tscope: "session-maybe"
\t\t\t\t\t\t},
\t\t\t\t\t\t"plugins.center": {
\t\t\t\t\t\t\tkind: "single",
\t\t\t\t\t\t\tscope: "root"
\t\t\t\t\t\t},`,
    'center slot declaration')
  return Buffer.from(source)
}

export function patchPluginCenterWorkspace(input) {
  let source = input.toString()
  // Older checked-in previews used the same glyph with a small, off-center
  // drawing inside its 16×16 viewport. Upgrade that injected component before
  // the normal idempotent patch check; clean upstream bundles have neither.
  source = source.replace(
    'V2.5Z",\n\t\t\t\t\tstroke: "currentColor",',
    'V2.5Z",\n\t\t\t\t\ttransform: "translate(0 -0.75) scale(1.2)",\n\t\t\t\t\tstroke: "currentColor",',
  )
  source = replaceOnce(source,
    '\t\tfunction WorkspaceBrowser({ wide,',
    `\t\tfunction PluginOutline16({ size = 16 }) {
\t\t\treturn (0, react_jsx_runtime.jsx)("svg", {
\t\t\t\twidth: size,
\t\t\t\theight: size,
\t\t\t\tviewBox: "0 0 16 16",
\t\t\t\tfill: "none",
\t\t\t\t"aria-hidden": true,
\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("path", {
\t\t\t\t\td: "M2.4 2.5h3.05c-.15.64.26 1.18.9 1.18s1.05-.54.9-1.18h3.65v3.05c.64-.15 1.18.26 1.18.9s-.54 1.05-1.18.9v3.65H7.85c.15.64-.26 1.18-.9 1.18s-1.05-.54-.9-1.18H2.4V7.85c-.64.15-1.18-.26-1.18-.9s.54-1.05 1.18-.9V2.5Z",
\t\t\t\t\ttransform: "translate(0 -0.75) scale(1.2)",
\t\t\t\t\tstroke: "currentColor",
\t\t\t\t\tstrokeWidth: 1.15,
\t\t\t\t\tstrokeLinecap: "round",
\t\t\t\t\tstrokeLinejoin: "round"
\t\t\t\t})
\t\t\t});
\t\t}
\t\tfunction WorkspaceBrowser({ wide,`,
    'plugin icon component')
  source = replaceOnce(source,
    '\t\t\tconst [wsPickerOpen, setWsPickerOpen] = (0, react.useState)(false);',
    `\t\t\tconst [wsPickerOpen, setWsPickerOpen] = (0, react.useState)(false);
\t\t\tconst [pluginCenterOpen, setPluginCenterOpen] = (0, react.useState)(false);
\t\t\t(0, react.useEffect)(() => {
\t\t\t\tconst opened = () => setPluginCenterOpen(true);
\t\t\t\tconst closed = () => setPluginCenterOpen(false);
\t\t\t\twindow.addEventListener("xharness:plugins:open", opened);
\t\t\t\twindow.addEventListener("xharness:plugins:closed", closed);
\t\t\t\treturn () => {
\t\t\t\t\twindow.removeEventListener("xharness:plugins:open", opened);
\t\t\t\t\twindow.removeEventListener("xharness:plugins:closed", closed);
\t\t\t\t};
\t\t\t}, []);`,
    'workspace view state')
  const wide = `, wide && (0, react_jsx_runtime.jsx)(_xharness_dsh_client_ui_primitives.Tooltip, {
\t\t\t\t\t\t\t\t\tlabel: t("plugins.open"),
\t\t\t\t\t\t\t\t\tside: "bottom",
\t\t\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("button", {
\t\t\t\t\t\t\t\t\t\ttype: "button",
\t\t\t\t\t\t\t\t\t\tclassName: WorkspaceBrowser_module_css_default.iconButton,
\t\t\t\t\t\t\t\t\t\t"data-xharness-plugin-nav": true,
\t\t\t\t\t\t\t\t\t\t"aria-label": t("plugins.open"),
\t\t\t\t\t\t\t\t\t\t"aria-current": pluginCenterOpen ? "page" : void 0,
\t\t\t\t\t\t\t\t\t\tstyle: pluginCenterOpen ? { background: "var(--dsw-alias-interactive-bg-hover)" } : void 0,
\t\t\t\t\t\t\t\t\t\tonClick: () => window.dispatchEvent(new Event("xharness:plugins:open")),
\t\t\t\t\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)(PluginOutline16, { size: 20 })
\t\t\t\t\t\t\t\t\t})
\t\t\t\t\t\t\t})`
  source = replaceOnce(source,
    'children: (0, react_jsx_runtime.jsx)(_xharness_dsh_client_ui_primitives.IconProjectAddOutline16, { size: wide ? 16 : 18 })\n\t\t\t\t\t\t\t\t\t})\n\t\t\t\t\t\t\t\t})]',
    'children: (0, react_jsx_runtime.jsx)(_xharness_dsh_client_ui_primitives.IconProjectAddOutline16, { size: wide ? 16 : 18 })\n\t\t\t\t\t\t\t\t\t})\n\t\t\t\t\t\t\t\t})' + wide + ']',
    'wide plugin button')
  source = replaceOnce(source,
    '\t\t\t\t\t(0, react_jsx_runtime.jsx)("div", {\n\t\t\t\t\t\tclassName: WorkspaceBrowser_module_css_default.listArea,',
    `\t\t\t\t\t!wide && (0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\t\tclassName: WorkspaceBrowser_module_css_default.search,
\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)(_xharness_dsh_client_ui_primitives.Tooltip, {
\t\t\t\t\t\t\t\tlabel: t("plugins.open"),
\t\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("button", {
\t\t\t\t\t\t\t\t\ttype: "button",
\t\t\t\t\t\t\t\t\tclassName: WorkspaceBrowser_module_css_default.searchButton,
\t\t\t\t\t\t\t\t\t"data-xharness-plugin-nav": true,
\t\t\t\t\t\t\t\t\t"aria-label": t("plugins.open"),
\t\t\t\t\t\t\t\t\t"aria-current": pluginCenterOpen ? "page" : void 0,
\t\t\t\t\t\t\t\t\tstyle: pluginCenterOpen ? { background: "var(--dsw-alias-interactive-bg-hover)" } : void 0,
\t\t\t\t\t\t\t\t\tonClick: () => window.dispatchEvent(new Event("xharness:plugins:open")),
\t\t\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)(PluginOutline16, { size: 22 })
\t\t\t\t\t\t\t\t})
\t\t\t\t\t\t})
\t\t\t\t\t}),
\t\t\t\t\t(0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\t\tclassName: WorkspaceBrowser_module_css_default.listArea,`,
    'compact plugin button')
  source = replaceOnce(source,
    '"workspace.add": "添加工作区",',
    '"workspace.add": "添加工作区",\n\t\t\t"plugins.open": "插件",',
    'Chinese plugin label')
  source = replaceOnce(source,
    '"workspace.add": "Add workspace",',
    '"workspace.add": "Add workspace",\n\t\t\t"plugins.open": "Plugins",',
    'English plugin label')
  return Buffer.from(source)
}

export function patchPluginCenterSettings(input) {
  let source = input.toString()
  source = replaceOnce(source,
    'ctx.slots.inject("settings.section", () => ctx.slots.register({\n\t\t\t\tname: "settings.section",\n\t\t\t\tid: "plugins",',
    'ctx.slots.inject("plugins.advanced", () => ctx.slots.register({\n\t\t\t\tname: "plugins.advanced",\n\t\t\t\tid: "plugins",',
    'plugin section registration')
  return Buffer.from(source)
}

export function patchPluginCenter(id, bytes) {
  if (id === ids.layout || id === '@deepseek-ai/dsh-client-ui-layout') return patchPluginCenterLayout(bytes)
  if (id === ids.workspace || id === '@deepseek-ai/dsh-client-ui-workspace') return patchPluginCenterWorkspace(bytes)
  if (id === ids.settings || id === '@deepseek-ai/dsh-client-ui-settings-plugins') return patchPluginCenterSettings(bytes)
  return bytes
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16)
}

export function patchPluginCenterDist(dist) {
  const graphPath = resolve(dist, 'client-graph.json')
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'))
  let html = readFileSync(resolve(dist, 'index.html'), 'utf8')
  for (const id of Object.values(ids)) {
    const path = resolve(dist, 'plugins', id, 'client.js')
    const before = readFileSync(path)
    const after = patchPluginCenter(id, before)
    if (!after.equals(before)) writeFileSync(path, after)
    const entry = graph.entries.find((item) => item.id === id)
    if (!entry) throw new Error(`plugin center: missing graph entry ${id}`)
    const previousUrl = entry.url
    entry.rev = hash(after)
    entry.url = `/plugins/${id}/client.js?rev=${entry.rev}`
    html = html.replaceAll(previousUrl, entry.url)
  }
  graph.rev = hash(Buffer.from(JSON.stringify(graph.entries)))
  const boot = html.match(/window\.__DSH_BOOT__ = (.*?)<\/script>/)
  if (!boot) throw new Error('plugin center: missing HTML boot graph')
  html = html.replace(boot[0], `window.__DSH_BOOT__ = ${JSON.stringify(graph)}</script>`)
  writeFileSync(graphPath, JSON.stringify(graph, null, 2) + '\n')
  writeFileSync(resolve(dist, 'index.html'), html)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  patchPluginCenterDist(resolve(process.argv[2] ?? 'ui/dist'))
}
