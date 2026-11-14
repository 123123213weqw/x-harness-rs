import type { ReactNode } from 'react'

/** Presentation identity only: never grants or dispatches a tool capability. */
export type ToolGlyphKind = 'thought' | 'read' | 'write' | 'edit' | 'search' | 'terminal' | 'browser' | 'computer' | 'image' | 'web' | 'agent' | 'list' | 'code' | 'plugin' | 'document' | 'history' | 'stop' | 'goal' | 'question' | 'tool'

const GLYPHS: Readonly<Record<string, ToolGlyphKind>> = {
  thought: 'thought', read: 'read', write: 'write', edit: 'edit', grep: 'search', glob: 'search',
  bash: 'terminal', pwsh: 'terminal', job_output: 'terminal', job_list: 'list', job_kill: 'stop',
  web_search: 'search', web_fetch: 'web', run_code: 'code', computer: 'computer', display: 'image',
  agent: 'agent', history: 'history', todolist: 'list', todo_write: 'list', ask_question: 'question',
  edit_goal_objective: 'goal', goal_report: 'goal', plugin_skill: 'plugin', plugin_mcp: 'plugin',
  cordis_define: 'code', cordis_package_inspect: 'plugin', cordis_runtime_inspect: 'plugin',
  cordis_run: 'plugin', cordis_stop: 'stop', cordis_undefine: 'plugin',
}

const LABELS: Readonly<Record<string, string>> = {
  computer: 'Computer', display: 'Image', history: 'History', agent: 'Agent',
  plugin_mcp: 'MCP', plugin_skill: 'Skill', job_list: 'Jobs', job_output: 'Job output',
  job_kill: 'Stop job', edit_goal_objective: 'Edit objective', goal_report: 'Goal report',
}
export function toolDisplayName(name: string): string | undefined {
  return Object.hasOwn(LABELS, name) ? LABELS[name] : undefined
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Decode only the exact MCP presentation target. Streamed/malformed/large
 * arguments keep the neutral plugin glyph; no substring-based tool guessing. */
export function toolGlyphKind(name: string, argsRaw?: string): ToolGlyphKind {
  if (name === 'plugin_mcp' && argsRaw !== undefined && argsRaw.length <= 16_384) {
    try {
      const args: unknown = JSON.parse(argsRaw)
      if (record(args) && args.action === 'call') {
        if (args.plugin === '@xharness/native-browser' && (args.server === 'browser' || args.server === 'webview')
          || args.plugin === 'browser-use' && args.server === 'browser') return 'browser'
        if (args.plugin === 'wordcraft') return 'document'
      }
    } catch { /* Incomplete arguments are normal during streaming. */ }
  }
  return Object.hasOwn(GLYPHS, name) ? GLYPHS[name] ?? 'tool' : 'tool'
}

/** Small, monochrome SVGs share one stroke and do not load fonts or images.
 * Tool identity stays stable when execution changes to failed/interrupted. */
export function ToolGlyph({ name, argsRaw, kind, size = 16 }: {
  name?: string; argsRaw?: string | undefined; kind?: ToolGlyphKind; size?: number
}) {
  const glyph = kind ?? toolGlyphKind(name ?? '', argsRaw)
  let body: ReactNode
  switch (glyph) {
    case 'thought': body = <><path d="M12 5a3 3 0 0 0-6-1 4 4 0 0 0-3 6 4 4 0 0 0 1 7 4 4 0 0 0 8 1V5Zm0 0a3 3 0 0 1 6-1 4 4 0 0 1 3 6 4 4 0 0 1-1 7 4 4 0 0 1-8 1"/><path d="M6 4v3m-3 3h4m-3 7h3m11-13v3m3 3h-4m3 7h-3M7 11v3m10-3v3"/></>; break
    case 'read': body = <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 13h8m-8 4h6"/></>; break
    case 'write': body = <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9M14 3v6h6V9l-6-6M19 14v8m-4-4h8"/></>; break
    case 'edit': body = <><path d="M12 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="m12 12 7-7a2 2 0 0 1 3 3l-7 7-4 1Zm5-5 3 3M8 17h2"/></>; break
    case 'search': body = <><circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/></>; break
    case 'terminal': body = <><path d="m4 6 6 6-6 6m10 0h7"/></>; break
    case 'browser': body = <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M6 6.5h.01M9 6.5h.01"/></>; break
    case 'computer': body = <><path d="m5 3 14 9-7 1-3 7-4-17Zm7 10 5 7"/></>; break
    case 'image': body = <><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m21 15-5-5L5 21"/></>; break
    case 'document': body = <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9ZM14 3v6h6M8 13h8m-4 0v5"/></>; break
    case 'web': body = <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c-5 5-5 13 0 18 5-5 5-13 0-18Z"/></>; break
    case 'agent': body = <><circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="12" cy="19" r="2"/><path d="M6 7v3c0 4 6 2 6 7m6-10v3c0 4-6 2-6 7"/></>; break
    case 'list': body = <><path d="m3 6 1.5 1.5L7 5m3 1h11m-18 6h3m4 0h11M3 18h3m4 0h11"/></>; break
    case 'code': body = <><path d="m7 7-5 5 5 5m10-10 5 5-5 5M14 4l-4 16"/></>; break
    case 'plugin': body = <><path d="M8 3v5m8-5v5M6 8h12v4a6 6 0 0 1-12 0Zm6 10v4"/></>; break
    case 'history': body = <><path d="M3 5v5h5M3 10a9 9 0 1 1 1 7m8-11v6l4 2"/></>; break
    case 'stop': body = <><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9h6v6H9Z"/></>; break
    case 'goal': body = <><path d="M5 22V3m0 0c5-5 9 5 14 0v10c-5 5-9-5-14 0"/></>; break
    case 'question': body = <><circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 5m0 3h.01"/></>; break
    default: body = <><path d="M9 3 7 8l-4 2v4l4 2 2 5h6l2-5 4-2v-4l-4-2-2-5Z"/><circle cx="12" cy="12" r="3"/></>
  }
  return <svg data-tool-glyph={glyph} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{body}</svg>
}
