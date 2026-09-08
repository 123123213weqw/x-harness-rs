// Small fail-closed adapter over the upstream compiled module. The UI extension
// lives in versioned product source; rebuilding upstream cannot silently drop it.
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(resolve(root, 'ui/overrides/model-controls.js'), 'utf8').replaceAll('\r\n', '\n')
const begin = '// XHARNESS MODEL CONTROLS BEGIN\n'
const end = '// XHARNESS MODEL CONTROLS END\n'
function once(text, before, after) {
  if (text.split(before).length !== 2) throw new Error('upstream model-controls signature changed: ' + before.slice(0, 100))
  return text.replace(before, after)
}
export function patchModelControls(bytes) {
  let text = bytes.toString('utf8').replaceAll('\r\n', '\n')
  if (text.includes(begin)) {
    const start = text.indexOf(begin), finish = text.indexOf(end, start)
    if (finish < 0) throw new Error('unterminated model-controls source')
    text = text.slice(0,start) + begin + source + end + text.slice(finish + end.length)
  } else {
    text = once(text, '...selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort }', '...selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort },\n                    ...selection.contextWindowTokens === void 0 ? {} : { contextWindowTokens: selection.contextWindowTokens }')
    text = once(text, 'const { result } = await this.sessions.models({ sessionId: this.sessionId });', 'const { result } = await xhModelRequest(this, generation, this.sessions.models({ sessionId: this.sessionId }));')
    text = once(text, 'const { result } = await this.sessions.selectModel({', 'const { result } = await xhModelRequest(this, generation, this.sessions.selectModel({')
    text = once(text, '...selection.contextWindowTokens === void 0 ? {} : { contextWindowTokens: selection.contextWindowTokens }\n\t\t\t\t});', '...selection.contextWindowTokens === void 0 ? {} : { contextWindowTokens: selection.contextWindowTokens }\n\t\t\t\t}));')
    text = once(text, '}, ModelSelect));', '}, XHarnessModelSelect));')
    text = once(text, '\t\texports.ModelDirectory = ModelDirectory;', begin + source + end + '\t\texports.ModelDirectory = ModelDirectory;\n        exports.XHarnessModelControls = XHarnessModelControls;\n        exports.xhContextSelection = xhContextSelection;\n        exports.xhModelInfo = xhModelInfo;')
  }
  // Upgrade both the raw upstream module and our earlier separate-button adapter.
  text = text.replace('exports.XHarnessModelControls = XHarnessModelControls;', 'exports.XHarnessModelSelect = XHarnessModelSelect;');
  if (!text.includes('// XHARNESS NESTED CONTEXT MENU')) {
    text = once(text, 'function ModelSelect({ locked, available, directory, load, select, t }) {', '// XHARNESS NESTED CONTEXT MENU\n\t\tfunction ModelSelect({ locked, available, directory, load, select, t }) {');
    text = once(text, 'const lastActionRef = (0, react.useRef)("load");', `const lastActionRef = (0, react.useRef)("load");
      (0, react.useEffect)(() => { setPane("root"); }, [state.current?.provider, state.current?.model]);`);
    text = once(text, 'if (!open) return;\n\t\t\t\tif (event.key === "ArrowDown"', 'if (!open || pane === "context") return;\n\t\t\t\tif (event.key === "ArrowDown"');
    text = once(text, '...effort === void 0 ? {} : { reasoningEffort: effort }', '...effort === void 0 ? {} : { reasoningEffort: effort },\n                    ...state.current.contextWindowTokens === void 0 ? {} : { contextWindowTokens: state.current.contextWindowTokens }');
    const caption = `effortLabel !== void 0 && (0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\t\t\tclassName: ModelSelect_module_css_default.triggerEffort,
\t\t\t\t\t\t\t\tchildren: effortLabel
\t\t\t\t\t\t\t}),`;
    text = once(text, caption, 'null,');
    text = once(text, 'role: "menu",\n\t\t\t\t\t\t"aria-label": t("menu.aria"),', 'role: pane === "context" ? "dialog" : "menu",\n\t\t\t\t\t\t"aria-label": pane === "context" ? "调整上下文容量" : t("menu.aria"),');
    const anchor = '\t\t\t\t\t\t\tpane === "model" &&';
    const before = '\t\t\t\t\t\t\t})] }),\n' + anchor;
    const after = `\t\t\t\t\t\t\t}), react.createElement(XHarnessContextRow, {state, itemRef: itemRef(), open: () => setPane("context")})] }),
              pane === "context" && react.createElement(XHarnessContextPane, {locked, directory, load: reload, select, back: () => setPane("root"), saved: () => close(true)}),
` + anchor;
    text = once(text, before, after);
  }
  if (!text.includes('// XHARNESS SAFARI MENU BLUR')) {
    text = once(text, 'const onBlur = (event) => {', `const onBlur = (event) => {
      // XHARNESS SAFARI MENU BLUR: clicking a non-focusable menu button in WebKit
      // blurs the input with null relatedTarget before click. Outside clicks are
      // already handled by the document listener; do not unmount the form here.
      if (event.relatedTarget === null) return;`);
  }
  return Buffer.from(text.replace(/\n\/\/# sourceMappingURL=client.js.map\s*$/, '').trimEnd() + '\n')
}
export function patchModelConnection(bytes) {
  let text = bytes.toString('utf8').replaceAll('\r\n', '\n')
  const marker = '// XHARNESS MODEL CAPABILITY WIRE'
  if (!text.includes(marker)) {
    text = once(text, 'const modelSelectionSchema = object({', marker + '\n\t\tconst modelSelectionSchema = object({\n            contextWindowTokens: number().int().positive().optional(),')
    text = once(text, 'const modelCatalogModelSchema = object({', 'const modelCatalogModelSchema = object({\n            contextWindow: number().int().positive().optional(),\n            contextWindowSource: string().optional(),\n            contextWindowCapability: unknown().optional(),')
  }
  return Buffer.from(text.replace(/\n\/\/# sourceMappingURL=client.js.map\s*$/, '').trimEnd() + '\n')
}
export function refreshModelControls(dist) {
  const hash = value => createHash('sha256').update(value).digest('hex').slice(0,16)
  const graphPath = resolve(dist, 'client-graph.json')
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'))
  const writes = []
  for (const [id, patch] of [
    ['@deepseek-ai/dsh-client-ui-model-selection', patchModelControls],
    ['@deepseek-ai/dsh-client-connection', patchModelConnection],
  ]) {
    const path = resolve(dist, `plugins/${id}/client.js`)
    const bytes = patch(readFileSync(path))
    const entry = graph.entries.find(e => e.id === id)
    if (!entry) throw new Error('missing graph entry: ' + id)
    entry.rev = hash(bytes); entry.url = `/plugins/${id}/client.js?rev=${entry.rev}`
    writes.push({path, bytes})
  }
  graph.rev = hash(JSON.stringify(graph.entries))
  const indexPath = resolve(dist, 'index.html')
  const html = readFileSync(indexPath, 'utf8')
  if (!/window\.__DSH_BOOT__ = .*?<\/script>/.test(html)) throw new Error('missing boot graph')
  for (const {path, bytes} of writes) {
    writeFileSync(path, bytes)
    try { unlinkSync(path + '.map') } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  writeFileSync(graphPath, JSON.stringify(graph,null,2)+'\n')
  let updatedHtml = html
  for (const entry of graph.entries) {
    // IDs are literal strings, not regexes. Update potential preloaded script URLs.
    const prefix = `/plugins/${entry.id}/client.js?rev=`
    const start = updatedHtml.indexOf(`src="${prefix}`)
    if (start >= 0) {
      const finish = updatedHtml.indexOf('"', start + 5)
      updatedHtml = updatedHtml.slice(0, start + 5) + entry.url + updatedHtml.slice(finish)
    }
  }
  writeFileSync(indexPath, updatedHtml.replace(/window\.__DSH_BOOT__ = .*?<\/script>/, `window.__DSH_BOOT__ = ${JSON.stringify(graph)}</script>`))
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) refreshModelControls(resolve(process.argv[2] ?? resolve(root,'ui/dist')))
