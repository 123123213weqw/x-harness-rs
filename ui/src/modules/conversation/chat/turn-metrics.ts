import { totalOutputTokens, throughput } from '../../shared/reception-metrics'
// Latency/throughput folds shared by the settled turn footer and StatsLine.

import type { AssistantMessageNode, ConversationNode } from "../types/runtime"

/** Latency and decode-throughput readings for one turn's footer. */
export interface TurnMetrics {
  /** First-step TTFT in ms; absent when that step carries no recorded timing. */
  ttftMs?: number
  /** Decode throughput over steps carrying both timing and provider usage. */
  tokensPerSecond?: number
}

/** One assistant step's derivable latency facts; null marks an unrecorded part. */
export interface StepReading {
  /** step/start → first token delta, in ms. */
  ttftMs: number | null
  /** First token delta → final message, in ms. */
  decodeMs: number | null
  /** Provider-reported completion tokens. */
  outputTokens: number | null
}

interface UsageLike {
  outputTokens?: number
}

type AssistantNode = AssistantMessageNode


/**
 * Read one assistant node's TTFT, decode wall time, and output tokens.
 * @param node - A settled assistant node.
 * @returns Per-part readings with `null` for unrecorded values.
 */
export function assistantStepReading(node: AssistantNode): StepReading {
  const timing = node.timing
  const ttftMs = timing !== undefined && timing.stepStartTime !== null && timing.firstTokenTime !== null
    ? Math.max(0, timing.firstTokenTime - timing.stepStartTime)
    : null
  const decodeMs = timing !== undefined && timing.firstTokenTime !== null
    ? (timing.receptionMs ?? (timing.completedTime > timing.firstTokenTime ? timing.completedTime-timing.firstTokenTime : Math.max(1,timing.completedTime-(timing.stepStartTime??timing.firstTokenTime))))
    : null
  return { ttftMs, decodeMs, outputTokens: totalOutputTokens(node.usage) }
}

interface TurnFold {
  firstStep: number
  firstStepTtftMs: number | null
  decodeMs: number
  outputTokens: number
  sampled: boolean
}

/**
 * Fold assistant nodes into per-turn footer metrics.
 *
 * TTFT is the turn's lowest-step request-dispatch-to-first-token reading, so
 * it is only meaningful when the turn's start is inside
 * the loaded window (the caller gates on `turnTimings`, which shares that
 * window). Throughput divides summed output tokens by summed decode wall time,
 * counting only steps that carry both.
 * @param nodes - Snapshot nodes of the loaded window.
 * @returns Turn number → available metrics; turns with none are absent.
 */
export function deriveTurnMetrics(nodes: readonly ConversationNode[]): Map<number, TurnMetrics> {
  const folds = new Map<number, TurnFold>()
  const routes = new Map<number, AssistantNode>()
  for (const node of nodes) {
    if (node.kind === 'assistant' && node.provenance !== undefined
      && node.step >= (routes.get(node.turn)?.step ?? -1)) routes.set(node.turn,node)
  }
  for (const node of nodes) {
    if (node.kind !== 'assistant') continue
    const reading = assistantStepReading(node)
    let fold = folds.get(node.turn)
    if (fold === undefined) {
      fold = { firstStep: node.step, firstStepTtftMs: reading.ttftMs, decodeMs: 0, outputTokens: 0, sampled: false }
      folds.set(node.turn, fold)
    } else if (node.step < fold.firstStep) {
      fold.firstStep = node.step
      fold.firstStepTtftMs = reading.ttftMs
    }
    const route = routes.get(node.turn)?.provenance
    const sameRoute = route === undefined || (node.provenance?.provider === route.provider && node.provenance?.model === route.model)
    if (sameRoute && reading.decodeMs !== null && reading.outputTokens !== null) {
      fold.decodeMs += reading.decodeMs
      fold.outputTokens += reading.outputTokens
      fold.sampled = true
    }
  }
  const metrics = new Map<number, TurnMetrics>()
  for (const [turn, fold] of folds) {
    const entry: TurnMetrics = {}
    if (fold.firstStepTtftMs !== null) entry.ttftMs = fold.firstStepTtftMs
    const rate = fold.sampled ? throughput(fold.outputTokens,fold.decodeMs) : null
    if (rate !== null) entry.tokensPerSecond = rate
    if (entry.ttftMs !== undefined || entry.tokensPerSecond !== undefined) metrics.set(turn, entry)
  }
  return metrics
}
