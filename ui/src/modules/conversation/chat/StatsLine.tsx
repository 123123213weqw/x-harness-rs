// Settled-node identity prevents stream-delta updates from rerendering this row.
// Mounted on 'conversation.composer.dock' so it sticks with the composer in the
// active conversation scrollport (see ConversationRoot data-conversation-scroll).

import { throughput } from '../../shared/reception-metrics'
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react'
import { IconChecklistOutline14 } from '../primitives'
import type { ConversationSnapshot, UseProjection } from "../types/runtime"
import type { SnapshotSelectorHook } from "../types/slots"
import type { ContextComposition, ContextPressureProjection, TokenUsageProjection } from "../types/wire"
import type { ComposerBarProps } from '../contract/slots'
import { formatTokensPerSecond } from './message-chrome'
import { assistantStepReading } from './turn-metrics'
import css from './StatsLine.styles'

interface WindowStats {
  turns: number
  steps: number
  /** Summed request wall time (step/start → assistant/message); 0 when no node carries timing. */
  llmMs: number
  /** Summed tool wall time (tool/call → tool/result); 0 when no pair is in-window. */
  toolMs: number
  /** Summed first-token latency over `ttftSteps`; 0 when no step records it. */
  ttftMs: number
  /** Steps carrying a recorded TTFT. */
  ttftSteps: number
  /** Summed decode wall time over steps that also report output tokens. */
  decodeMs: number
  /** Summed output tokens over the same decode-timed steps. */
  decodeTokens: number
}

/**
 * Fold assistant and tool-result nodes into window-scoped display totals —
 * the FALLBACK for assemblies without the `sessionStats` projection.
 *
 * Every displayed figure rides that durable whole-log projection (and token
 * accounting rides `tokenUsage`) because the window is paged and compaction
 * rewrites it; this fold answers "what is on screen" only when no projection
 * value is served. Its field names deliberately mirror the projection's so
 * the two swap wholesale.
 * @param nodes - snapshot nodes.
 * @returns fallback counts and summed wall times.
 */
export function deriveStats(nodes: ConversationSnapshot['nodes']): WindowStats {
  const turns = new Set<number>()
  let steps = 0
  let llmMs = 0
  let toolMs = 0
  let ttftMs = 0
  let ttftSteps = 0
  let decodeMs = 0
  let decodeTokens = 0
  for (const node of nodes) {
    if (node.kind === 'tool-result') {
      if (node.callTime !== null) toolMs += Math.max(0, node.time - node.callTime)
      continue
    }
    if (node.kind !== 'assistant') continue
    turns.add(node.turn)
    steps += 1
    if (node.timing !== undefined && node.timing.stepStartTime !== null) {
      llmMs += Math.max(0, node.timing.completedTime - node.timing.stepStartTime)
    }
    const reading = assistantStepReading(node)
    if (reading.ttftMs !== null) {
      ttftMs += reading.ttftMs
      ttftSteps += 1
    }
    if (reading.decodeMs !== null && reading.outputTokens !== null) {
      decodeMs += reading.decodeMs
      decodeTokens += reading.outputTokens
    }
  }
  return { turns: turns.size, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens }
}

/**
 * Compact token count: 517 / 12.2K / 517K / 1.2M (one decimal under three digits).
 * @param n - token count.
 * @returns display string.
 */
export function formatTokens(n: number): string {
  const scaled = (v: number): string =>
    v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`
  return `${scaled(n / 1_000_000)}M`
}

/**
 * Compact duration: 45.2s under a minute, 2m42s from there on.
 * @param ms - duration in milliseconds.
 * @returns display string.
 */
export function formatDuration(ms: number): string {
  const s = ms / 1_000
  if (s < 60) return `${Math.round(s * 10) / 10}s`
  const whole = Math.round(s)
  return `${Math.floor(whole / 60)}m${whole % 60}s`
}

/**
 * Cache-hit share of prompt-side input over the whole durable log.
 * @param usage - the session's token-usage projection value.
 * @returns rounded integer percent, or null when no input was billed.
 */
export function cacheHitPercent(usage: TokenUsageProjection): number | null {
  const denominator = billedInputTokens(usage)
  return denominator === 0
    ? null
    : Math.round(usage.cacheReadTokens / denominator * 100)
}

/**
 * Sum the three disjoint prompt-side billing buckets.
 * @param usage - the session's token-usage projection value.
 * @returns billed input tokens.
 */
export function billedInputTokens(usage: TokenUsageProjection): number {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

interface ContextOccupancy {
  percent: number
  usedTokens: number
  contextWindow: number
  exact: boolean
  label: string
  accuracy: string
  stale: boolean
  composition?: ContextComposition | undefined
}

/** The ring is a request-bound provider sample, never an admission byte ceiling.
 * Pending estimates remain separate so preparation/interruptions cannot reprice
 * an earlier sample or swap its composition with a different request's shares.
 */
export function contextOccupancy(
  pressure: ContextPressureProjection | undefined,
): ContextOccupancy | null {
  const current = pressure?.pressureTokens
  const measured = Number.isSafeInteger(current) && (current ?? -1) >= 0 && (pressure?.pressureAccuracy ?? 'provider_reported') === 'provider_reported'
  const sample = pressure?.lastMeasured ?? (measured ? { tokens: current, contextWindow: pressure?.contextWindow, composition: pressure?.composition } : undefined)
  const usedTokens = sample?.tokens, contextWindow = sample?.contextWindow
  if (usedTokens === undefined || !Number.isSafeInteger(usedTokens) || usedTokens < 0 || contextWindow === undefined || !Number.isSafeInteger(contextWindow) || contextWindow <= 0) return null
  // Keep the sample's own denominator even if route capacity changes meanwhile.
  const stale = !measured || pressure?.phase === 'history_changed'
  const label = '最近请求实际输入' + (stale ? ' · 待更新' : '')
  return { percent: Math.min(100, Math.round(usedTokens / contextWindow * 100)), usedTokens, contextWindow, exact: true, label, accuracy: 'provider_reported', stale, composition: sample?.composition }
}

/** Props: the conversation-snapshot selector plus the projection read seat. */
export interface StatsLineProps {
  useSession: SnapshotSelectorHook<ConversationSnapshot>
  useProjection: UseProjection
  /** The owning dock's locale seat. */
  t: ComposerBarProps['t']
}

export const StatsLine = memo(function StatsLine({ useSession, useProjection, t }: StatsLineProps) {
  const disclosureRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const panelId = useId()
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      const disclosure = disclosureRef.current
      if (disclosure !== null && event.target instanceof Node && !disclosure.contains(event.target)) setOpen(false)
    }
    const closeEscape = (event: globalThis.KeyboardEvent): void => {
      const disclosure = disclosureRef.current
      if (event.key !== 'Escape' || disclosure === null) return
      setOpen(false)
      disclosure.querySelector('button')?.focus()
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeEscape)
    }
  }, [open])
  const settledNodes = useSession(s => s.chat.legacy.nodes)
  const usage = useProjection('tokenUsage')
  // Every figure rides the durable sessionStats projection, so paging and
  // compaction cannot change any of them; an assembly without the unit falls
  // back to the window-scoped fold wholesale (same field names), paid only
  // while no projection value is served.
  const projected = useProjection('sessionStats')
  const stats = useMemo(() => projected ?? deriveStats(settledNodes), [projected, settledNodes])
  // Groups with no data drop out whole; all reported metrics remain available.
  const groups: string[] = []
  const rateTotals = projected?.activeThroughput ?? stats
  const rate = throughput(rateTotals.decodeTokens, rateTotals.decodeMs)
  const rateLabel = rate === null ? null : t('stats.tokensPerSecond', { throughput: formatTokensPerSecond(rate) })
  if (stats.steps > 0) {
    groups.push(t('stats.counts', { turns: stats.turns, steps: stats.steps }))
    const durations: string[] = []
    if (stats.llmMs > 0) durations.push(t('stats.llm', { duration: formatDuration(stats.llmMs) }))
    if (stats.toolMs > 0) durations.push(t('stats.toolCall', { duration: formatDuration(stats.toolMs) }))
    if (durations.length > 0) groups.push(durations.join(' · '))
    const speeds: string[] = []
    if (stats.ttftSteps > 0) {
      speeds.push(t('stats.ttftAverage', { duration: formatDuration(stats.ttftMs / stats.ttftSteps) }))
    }
    if (rateLabel !== null) speeds.push(rateLabel)
    if (speeds.length > 0) groups.push(speeds.join(' · '))
  }
  // Context occupancy deliberately lives on the composer's ContextMeter ring,
  // not here — one home per fact.
  // Billing rides the durable projection, so these survive paging and
  // compaction. Gated on actual token activity: a session whose steps all
  // settled without billing (e.g. every request failed) shows its counts
  // without a zero-token group.
  if (usage !== undefined
    && (billedInputTokens(usage) > 0 || usage.outputTokens > 0)) {
    const cacheHit = cacheHitPercent(usage)
    if (cacheHit !== null) groups.push(t('stats.cacheHit', { percent: cacheHit }))
    groups.push(t('stats.tokens', {
      input: formatTokens(billedInputTokens(usage)),
      output: formatTokens(usage.outputTokens),
    }))
  }
  if (groups.length === 0) return null
  // Explicit disclosure keeps off-card content accessible in WebKit as well
  // as Chromium. It owns only open state, never token accounting.
  return (
    <div ref={disclosureRef} className={css.root} data-composer-stats data-expanded={open || undefined}>
      <button type="button" className={css.summary} aria-label={t('stats.title')} title={t('stats.title')}
        aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => {setOpen(!open)}}>
        <IconChecklistOutline14 />
      </button>
      {open && <div id={panelId} className={css.details} role="region" aria-label={t('stats.title')}>
        {groups.map(group => <div key={group}>{group}</div>)}
      </div>}
    </div>
  )
})
