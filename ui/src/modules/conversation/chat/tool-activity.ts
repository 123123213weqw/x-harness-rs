import { z } from 'zod'
import type { ChatConversationViewNode, ConversationSnapshot, ToolCallBlock } from '../types/runtime'
import { isChatNode } from '../contract/chat-node-codec'
import { isObjectRecord } from '../../shared/runtime-types'
import { toolDisplayName } from '../../shared/ToolGlyph'

export const TOOL_ACTIVITY_HOLD_MS = 800
export const TOOL_ACTIVITY_FLIP_MS = 300
const itemSchema = z.object({ key: z.string().max(160), name: z.string().max(80), title: z.string().max(64), summary: z.string().max(320), glyphArgs: z.string().max(2048).optional() })
const selectionSchema = z.object({ items: z.array(itemSchema).max(8), parallel: z.number().int().nonnegative(), blocked: z.boolean() })
export type ToolActivityItem = z.infer<typeof itemSchema>
export type ToolActivitySelection = z.infer<typeof selectionSchema>
export const EMPTY_TOOL_ACTIVITY: ToolActivitySelection = { items: [], parallel: 0, blocked: false }
const labels: Readonly<Record<string, string>> = { read: 'Read', write: 'Write', edit: 'Edit', grep: 'Search', glob: 'Search', web_search: 'Search', web_fetch: 'Web', bash: 'Bash', pwsh: 'Pwsh', run_code: 'Code', todolist: 'TodoList', todo_write: 'Todo' }

/** Only the preview is abbreviated. Raw calls and results remain in their sole owning tree. */
function short(value: string, limit = 160): string {
  return Array.from(value.slice(0, limit * 2 + 2)).slice(0, limit).join('').replace(/\s+/g, ' ').trim()
}
function preview(rawName: string, raw: string, key: string): ToolActivityItem {
  const name = rawName.length <= 80 ? rawName : ''
  let args: Record<string, unknown> = {}
  if (raw.length <= 16_384) {
    try { const value: unknown = JSON.parse(raw); if (isObjectRecord(value)) args = value } catch { /* Normal incomplete streamed input. */ }
  }
  const title = short(Object.hasOwn(labels, name) ? labels[name] ?? name : toolDisplayName(name) ?? rawName, 32)
  const fields = name === 'run_code' ? ['language'] : ['path', 'file_path', 'pattern', 'command', 'url', 'action']
  let summary = ''
  for (const field of fields) { const value = args[field]; if (typeof value === 'string') { summary = short(value); break } }
  // Glyph dispatch receives only bounded presentation identity, not the original payload.
  if (name === 'plugin_mcp' && args.action === 'call') {
    const browser = args.plugin === '@xharness/native-browser' && (args.server === 'browser' || args.server === 'webview') || args.plugin === 'browser-use' && args.server === 'browser'
    const document = args.plugin === 'wordcraft'
    const glyphArgs = browser ? JSON.stringify({ action: 'call', plugin: args.plugin, server: args.server }) : document ? JSON.stringify({ action: 'call', plugin: 'wordcraft', server: '' }) : undefined
    const nested = isObjectRecord(args.arguments) ? args.arguments : {}
    summary = typeof nested.action === 'string' ? short(nested.action) : typeof args.tool === 'string' ? short(args.tool) : ''
    return glyphArgs === undefined ? { key, name, title, summary } : { key, name, title: browser ? 'Browser' : 'WordCraft', summary, glyphArgs }
  }
  return { key, name, title, summary }
}
interface Metadata { item?: ToolActivityItem; running: boolean; barrier: number; dispatch: number; result: number; waiting: boolean }
const metadata = new WeakMap<ChatConversationViewNode, Metadata>()
function facts(node: ChatConversationViewNode): Metadata {
  const cached = metadata.get(node)
  if (cached !== undefined) return cached
  if (!isChatNode(node) || node.kind !== 'tool-call' || !Number.isFinite(node.anchorSeq)) return { running: false, barrier: Infinity, dispatch: -1, result: -1, waiting: false }
  const root = node.data.root, call = 'kind' in root ? root.call : root
  const location = node.location
  const scope = location?.kind === 'step' ? `${location.turn.turn}:${location.step.step}` : location?.kind === 'turn' ? `${location.turn.turn}:turn` : 'window'
  let barrier = -1, waiting = false
  const stack: ToolCallBlock[] = [root]
  for (let block = stack.pop(); block !== undefined; block = stack.pop()) {
    if ('kind' in block) {
      const view = block.resultView
      if (block.isError || block.error?.code === 'OUTCOME_UNKNOWN' || block.error?.code === 'interrupted'
        || view?.card === 'terminal' && (typeof view.exitCode === 'number' && view.exitCode !== 0 || typeof view.signal === 'string' && view.signal !== '')) barrier = Math.max(barrier, block.seq)
    } else if (block.name === 'ask_question') waiting = true
    stack.push(...block.subCalls)
  }
  const name = call?.name ?? ''
  const value: Metadata = { running: !('kind' in root), barrier, dispatch: name ? node.anchorSeq : -1,
    result: 'kind' in root ? root.seq : -1, waiting }
  if (call !== null && name && barrier < 0) value.item = preview(name, call.argsRaw, `${scope}:${node.anchorSeq}`)
  metadata.set(node, value)
  return value
}

/** Stable primitive selection: at most eight short active roots and one source-derived barrier.
 * Counts root invocations only: a parent awaiting its child is not another parallel invocation. */
export function selectToolActivity(keys: readonly string[], get: (key: string) => ChatConversationViewNode | undefined): string {
  const active = new Map<string, ToolActivityItem>()
  let recent: ToolActivityItem | undefined, result = -1, barrier = -1, dispatch = -1, waiting = false
  for (const key of keys) {
    const node = get(key)
    if (node === undefined || node.kind !== 'tool-call') continue
    const fact = facts(node)
    barrier = Math.max(barrier, fact.barrier); dispatch = Math.max(dispatch, fact.dispatch); waiting ||= fact.waiting
    if (fact.item === undefined) continue
    if (fact.running) active.set(fact.item.key, fact.item)
    else if (fact.result >= result) { recent = fact.item; result = fact.result }
  }
  const blocked = waiting || barrier >= 0 && barrier >= dispatch
  return JSON.stringify({ items: blocked ? [] : active.size ? [...active.values()].slice(-8) : recent === undefined ? [] : [recent], parallel: active.size, blocked })
}
/** One owner decides whether a real visible summary can replace ordinary live rows.
 * Returning only the turn keeps the structural list independent of token updates. */
export function liveToolSummaryTurn(snapshot: ConversationSnapshot): number | undefined {
  if (!snapshot.running || snapshot.stopRequested || snapshot.openState !== 'open' || (snapshot.pending?.length ?? 0) > 0) return undefined
  let turn = snapshot.chat.timeline.turnOrder?.at(-1)
  if (turn === undefined) for (const id of snapshot.chat.timeline.turns.keys()) turn = id
  if (turn === undefined || snapshot.chat.timeline.turns.get(turn)?.status !== 'open') return undefined
  const keys = snapshot.chat.locations?.getTurn(turn)
  if (keys === undefined) return undefined
  const input = decodeToolActivity(selectToolActivity(keys, key => snapshot.chat.nodes.get(key)))
  return input.blocked || input.items.length === 0 ? undefined : turn
}
export function decodeToolActivity(value: string): ToolActivitySelection {
  if (value === '' || value.length > 16_384) return EMPTY_TOOL_ACTIVITY
  try { const parsed: unknown = JSON.parse(value); return selectionSchema.safeParse(parsed).data ?? EMPTY_TOOL_ACTIVITY } catch { return EMPTY_TOOL_ACTIVITY }
}
export interface ToolActivityFrame { readonly current: ToolActivityItem | undefined; readonly previous: ToolActivityItem | undefined; readonly revision: number; readonly at: number }
function same(a: ToolActivityItem | undefined, b: ToolActivityItem | undefined): boolean {
  return a?.name === b?.name && a?.title === b?.title && a?.summary === b?.summary && a?.glyphArgs === b?.glyphArgs
}
/** Event-driven latest summary, never a cyclic recent-tool carousel.
 * Keep two faces and one coalesced latest input; no unbounded playback queue. */
export class ToolActivityPresentation {
  frame: ToolActivityFrame = { current: undefined, previous: undefined, revision: 0, at: 0 }
  private pending: ToolActivityItem | undefined
  private deadline: number | undefined
  private holdUntil = 0
  private now = 0
  reset(input: ToolActivitySelection, now: number): ToolActivityFrame {
    this.now = now; this.pending = undefined; this.deadline = undefined; this.holdUntil = now
    this.frame = { current: input.blocked ? undefined : input.items.at(-1), previous: undefined, revision: this.frame.revision + 1, at: now }
    return this.frame
  }
  freeze(): ToolActivityFrame {
    this.pending = undefined; this.deadline = undefined
    this.frame = { ...this.frame, previous: undefined }
    return this.frame
  }
  update(input: ToolActivitySelection, now: number, animate: boolean): ToolActivityFrame {
    if (input.blocked || input.items.length === 0 || this.frame.current === undefined || !animate) return this.reset(input, now)
    this.now = Math.max(this.now, now)
    const target = input.items.at(-1)
    if (target === undefined) return this.reset(input, now)
    if (target.key === this.frame.current.key || same(target, this.frame.current)) {
      // Same-call streamed arguments refresh in place, not one animation per token.
      this.frame = { ...this.frame, current: target }
      this.pending = undefined; this.deadline = undefined
    } else {
      this.pending = target
      this.deadline ??= Math.max(this.now, this.holdUntil)
    }
    return this.advance(this.now, animate)
  }
  advance(now: number, animate: boolean): ToolActivityFrame {
    this.now = Math.max(this.now, now)
    if (this.pending !== undefined && this.deadline !== undefined && this.now >= this.deadline) {
      // Busy/hidden renderers must not animate stale playback after a late callback.
      const onTime = this.now - this.deadline <= 250
      this.frame = { current: this.pending, previous: animate && onTime ? this.frame.current : undefined, revision: this.frame.revision + 1, at: this.now }
      this.pending = undefined; this.deadline = undefined; this.holdUntil = this.now + TOOL_ACTIVITY_HOLD_MS
    }
    if (this.frame.previous !== undefined && (!animate || this.now - this.frame.at >= TOOL_ACTIVITY_FLIP_MS)) this.frame = { ...this.frame, previous: undefined }
    return this.frame
  }
  get nextAt(): number | undefined {
    return this.frame.previous === undefined ? this.deadline : Math.min(this.frame.at + TOOL_ACTIVITY_FLIP_MS, this.deadline ?? Infinity)
  }
}
