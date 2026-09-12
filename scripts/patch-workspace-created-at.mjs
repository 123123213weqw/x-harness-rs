// Product-owned tolerant timestamp parsing for the upstream Workspace surfaces.
//
// The Host emits epoch milliseconds as a decimal string, but upstream parsed
// `workspace.createdAt` as a date string, so three call sites were broken:
// the hover card label, the sidebar group ordering key, and the runtime's
// recency fallback. Signature-checked so an upstream UI change fails the static
// assembly instead of silently restoring NaN.
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKSPACE_ID = '@deepseek-ai/dsh-client-ui-workspace'
const RUNTIME_ID = '@deepseek-ai/dsh-client-runtime'
const T = '\t'
const BEGIN = '// XHARNESS WORKSPACE CREATED-AT BEGIN'
const END = '// XHARNESS WORKSPACE CREATED-AT END'
const HELPER = readFileSync(resolve(root, 'ui/overrides/workspace-created-at.js'), 'utf8').replaceAll('\r\n', '\n')

function once(text, before, after) {
  if (text.split(before).length !== 2) {
    throw new Error('XHarness workspace timestamp anchor changed: ' + JSON.stringify(before.slice(0, 120)))
  }
  return text.replace(before, after)
}

function injected() {
  const body = HELPER.trimEnd()
    .split('\n')
    .map(line => (line === '' ? '' : T + T + line))
    .join('\n')
  return T + T + BEGIN + '\n' + body + '\n' + T + T + END + '\n'
}

export function patchWorkspaceCreatedAt(id, bytes) {
  if (id !== WORKSPACE_ID && id !== RUNTIME_ID) return bytes
  let text = bytes.toString('utf8').replaceAll('\r\n', '\n')
  if (text.includes(BEGIN)) return Buffer.from(text)
  const anchor = T + T + 'var module = { exports: {} };'
  text = once(text, anchor, injected() + anchor)
  if (id === WORKSPACE_ID) {
    text = once(text, 'Date.parse(workspace.createdAt)', 'xhEpochMs(workspace.createdAt)')
    text = once(
      text,
      T.repeat(3) + 'const d = new Date(createdAt);',
      T.repeat(3) + 'const d = new Date(xhEpochMs(createdAt));\n' +
        T.repeat(3) + 'if (!Number.isFinite(d.getTime())) return void 0;'
    )
    const indent = T.repeat(5)
    const hoverTime =
      '(0, react_jsx_runtime.jsx)("div", {\n' +
      T.repeat(6) + 'className: Rows_module_css_default.hoverTime,\n' +
      T.repeat(6) + 'children: createdLabel(createdAt, t)\n' +
      T.repeat(5) + '})'
    text = once(
      text,
      indent + hoverTime,
      indent + 'createdLabel(createdAt, t) === void 0 ? null : ' + hoverTime
    )
  } else {
    text = once(text, 'latest = Date.parse(workspace.createdAt)', 'latest = xhEpochMs(workspace.createdAt)')
  }
  return Buffer.from(text)
}

const TARGETS = [WORKSPACE_ID, RUNTIME_ID]
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16)

export function refreshWorkspaceCreatedAt(dist = resolve(root, 'ui/dist')) {
  const graphPath = resolve(dist, 'client-graph.json')
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'))
  for (const id of TARGETS) {
    const target = resolve(dist, 'plugins', id, 'client.js')
    const patched = patchWorkspaceCreatedAt(id, readFileSync(target))
    writeFileSync(target, patched)
    const entry = graph.entries.find(candidate => candidate.id === id)
    if (entry === undefined) throw new Error('client graph is missing ' + id)
    entry.rev = hash(patched)
    entry.url = `/plugins/${id}/client.js?rev=${entry.rev}`
  }
  graph.rev = hash(JSON.stringify(graph.entries))
  writeFileSync(graphPath, JSON.stringify(graph, null, 2) + '\n')
  const indexPath = resolve(dist, 'index.html')
  writeFileSync(
    indexPath,
    readFileSync(indexPath, 'utf8').replace(
      /window\.__DSH_BOOT__ = .*?<\/script>/,
      () => `window.__DSH_BOOT__ = ${JSON.stringify(graph)}</script>`
    )
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  refreshWorkspaceCreatedAt(resolve(process.argv[2] ?? resolve(root, 'ui/dist')))
}
