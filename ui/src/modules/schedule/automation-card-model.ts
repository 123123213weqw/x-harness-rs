import {objectValue} from '../shared/runtime-types'
import {validRecord, type ScheduleRecord} from './automation-data'
import type {ToolCallBlock} from '../client-runtime/index'

export interface AutomationView extends ScheduleRecord {
  state: string
  runs?: readonly {state: string; sessionId?: string}[]
}
const STATES = new Set(['scheduled', 'overdue', 'paused', 'finished', 'deleted', 'inherited', 'inactive'])
const RUN_STATES = new Set(['preparing', 'queued', 'running', 'completed', 'cancelled', 'failed', 'interrupted', 'incomplete', 'unavailable'])
export function automationView(raw: unknown): AutomationView | undefined {
  const value = objectValue(raw)
  if (!validRecord(raw) || typeof value.state !== 'string' || !STATES.has(value.state)) return undefined
  const rawRuns: readonly unknown[] | undefined = Array.isArray(value.runs) ? value.runs : undefined
  const runs = rawRuns?.flatMap(raw => {
    const run = objectValue(raw)
    return typeof run.state === 'string' && RUN_STATES.has(run.state)
      ? [{state: run.state, ...(typeof run.sessionId === 'string' ? {sessionId: run.sessionId} : {})}] : []
  })
  return {...raw, state: value.state, ...(runs === undefined ? {} : {runs})}
}
export function domainError(raw: unknown): string | undefined {
  const value = objectValue(raw), error = objectValue(value.error)
  if (typeof value.code === 'string' && typeof value.message === 'string') return value.message
  if (value.ok === false) return typeof error.message === 'string' ? error.message : typeof value.error === 'string' && value.error ? value.error : 'Operation failed'
  return undefined
}
function parse(text: string): unknown {
  if (text.length > 1_048_576) return undefined
  try { const value: unknown = JSON.parse(text); return value } catch { return undefined }
}
/** Decode only the established text-result envelope; never render model text as HTML. */
export function automationCardModel(block: ToolCallBlock) {
  const argsRaw = ('kind' in block ? block.call?.argsRaw : block.argsRaw) ?? ''
  const args = objectValue(parse(argsRaw))
  const action = typeof args.action === 'string' && ['create','update','list','view','pause','resume','delete'].includes(args.action) ? args.action : 'unknown'
  let output: unknown, raw = '', error: string | undefined
  const settled = 'kind' in block
  if (settled) {
    raw = block.content.map(part => { const p = objectValue(part); return p.type === 'text' && typeof p.text === 'string' ? p.text : '' }).join('\n')
    output = parse(raw)
    const envelope = objectValue(output)
    error = domainError(output)
    if (typeof envelope.content === 'string') output = parse(envelope.content)
    error ??= domainError(output)
    if (block.isError) error ??= block.error?.code ?? 'Operation failed'
  }
  const rawValues: readonly unknown[] = Array.isArray(output) ? output : [output]
  const values = rawValues.flatMap(value => { const view = automationView(value); return view === undefined ? [] : [view] })
  const outputId = objectValue(output).id
  const ids = error !== undefined ? [] : values.length ? values.map(v => v.id) : typeof outputId === 'string' ? [outputId] : settled && typeof args.id === 'string' ? [args.id] : []
  return {action, argsRaw, raw, error, settled, values, ids, recognized: values.length > 0 || (Array.isArray(output) && values.length === output.length) || typeof outputId === 'string' || error !== undefined}
}
/** A finished timer may still have an admitted run. Keep these two truths separate. */
export function latestRunState(view: AutomationView): string | undefined { return view.runs?.[0]?.state }
export function refreshDelay(view: AutomationView | undefined): number | undefined {
  if (view === undefined) return 15_000
  if (view.runs?.some(r => ['preparing','queued','running','unavailable'].includes(r.state))) return 5_000
  if (view.state === 'scheduled' || view.state === 'overdue') return Math.max(5_000, Math.min(3_600_000, Date.parse(view.scheduledAt) - Date.now() + 250))
  return undefined
}
