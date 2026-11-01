/** Presentation only: never reinterpret a process exit as successful execution. */
import {z} from 'zod'
import {isView} from './view-codec'
import type {ToolResultNode} from '../../types'

const processResult = z.looseObject({
  kind: z.literal('foreground'),
  stdout: z.string(),
  stderr: z.string(),
  exit_code: z.number().int().safe().nullable(),
  signal: z.union([z.string(), z.number().int().safe()]).nullable(),
  success: z.boolean(),
  termination: z.string().optional(),
})
const hostEnvelope = z.looseObject({
  ok: z.boolean(),
  error: z.string(),
  truncated: z.boolean(),
  content: z.unknown(),
})
const MAX_ENVELOPE_CHARS = 256 * 1024
const SCAN_CHARS = 32 * 1024
const LINE_CHARS = 240

function parse(text: string): unknown {
  if (text.length > MAX_ENVELOPE_CHARS) return undefined
  try { const value: unknown = JSON.parse(text); return value } catch { return undefined }
}

function lines(text: string): string[] {
  // Bound only the collapsed preview. Full output stays untouched in details.
  const window = text.length > SCAN_CHARS * 2
    ? text.slice(0, SCAN_CHARS) + '\n' + text.slice(-SCAN_CHARS) : text
  return window
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
}

function summary(exitCode: number | null, signal: string | number | null, stdout: string, stderr: string, termination?: string): string {
  const prefix = termination === 'timedout' ? 'Timed out'
    : termination === 'cancelled' ? 'Cancelled'
    : signal !== null ? `Signal ${signal}`
    : exitCode !== null && exitCode !== 0 ? `Exit ${exitCode}` : 'Tool failed'
  const errors = [...lines(stderr), ...lines(stdout)]
  const diagnostic = errors.find(line => /^(?:error(?:\[[^\]]+\])?:|fatal(?: error)?:|Traceback\b|.*command not found:)/i.test(line))
    ?? lines(stderr)[0]
  return diagnostic === undefined ? prefix : `${prefix} · ${diagnostic.slice(0, LINE_CHARS)}`
}

/** Accept only shell tools and known Host process/view envelopes. Generic tool
 * JSON, raw result output, success state and interruption semantics are retained.
 */
export function shellErrorSummary(toolName: string, node: ToolResultNode, output: string): string | null {
  if (toolName !== 'bash' && toolName !== 'pwsh') return null
  if (node.error?.code === 'interrupted') return null
  const terminal = isView(node.resultView, 'terminalResult') ? node.resultView : null
  const legacyExit = terminal !== null && ((terminal.exitCode !== undefined && terminal.exitCode !== 0) || terminal.signal !== undefined)
  if (!node.isError && !legacyExit) return null
  const metadata = processResult.safeParse(node.meta)
  if (metadata.success) {
    const p = metadata.data
    return summary(p.exit_code, p.signal, p.stdout, p.stderr, p.termination)
  }
  if (terminal !== null && (terminal.exitCode !== undefined || terminal.signal !== undefined)) {
    return summary(terminal.exitCode ?? null, terminal.signal ?? null, terminal.output ?? '', '')
  }
  const decoded = parse(output)
  const direct = processResult.safeParse(decoded)
  if (direct.success) {
    const p = direct.data
    return summary(p.exit_code, p.signal, p.stdout, p.stderr, p.termination)
  }
  const envelope = hostEnvelope.safeParse(decoded)
  if (!envelope.success) return null
  const inner = processResult.safeParse(typeof envelope.data.content === 'string'
    ? parse(envelope.data.content) : envelope.data.content)
  if (inner.success) {
    const p = inner.data
    return summary(p.exit_code, p.signal, p.stdout, p.stderr, p.termination)
  }
  // Execution/permission failures may not have launched a process at all.
  return envelope.data.ok === false ? lines(envelope.data.error)[0]?.slice(0, LINE_CHARS) ?? null : null
}
