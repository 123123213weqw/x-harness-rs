import { z } from 'zod'
/**
 * dsh-llm's owned branded ids: tool-call correlation and provider request
 * diagnostics.
 *
 * The zero-dependency type-only `Branded<B>` primitive is repository-owned
 * under contracts/util/brand; cross-boundary id owners share it without
 * acquiring a provider SDK or runtime dependency.
 *
 * @module @xharness/dsh-client-connection/contracts/llm/llm/brand
 */

import type { Branded } from '../../util/brand/index'

/** Stable identity carried by one message across inbox, log, and model-request boundaries. */
export type MessageId = Branded<'MessageId'>

/**
 * Brand a message identifier.
 * @param id - the opaque message identifier.
 * @returns the same string, branded; the input is checked as an opaque string.
 */
export function MessageId(id: string): MessageId {
  return z.string().brand<'MessageId'>().parse(id)
}

/**
 * Correlates a model-issued tool call with its result. Provider-issued for
 * real adapters; synthesized by mocks/assembler fallbacks.
 */
export type CallId = Branded<'CallId'>

/**
 * Brand a string as a {@link CallId}.
 * @param id - the provider-issued (or synthesized) call id.
 * @returns the same string, branded; the input is checked as an opaque string.
 */
export function CallId(id: string): CallId {
  return z.string().brand<'CallId'>().parse(id)
}

/** Provider-issued request identifier retained for diagnostics across package boundaries. */
export type ProviderRequestId = Branded<'ProviderRequestId'>

/**
 * Brand a provider-issued request identifier.
 * @param id - the opaque provider-issued string.
 * @returns the same string, branded; the input is checked as an opaque string.
 */
export function ProviderRequestId(id: string): ProviderRequestId {
  return z.string().brand<'ProviderRequestId'>().parse(id)
}

/** Adapter-owned identifier for one model's selectable reasoning effort. */
export type ReasoningEffortId = Branded<'ReasoningEffortId'>

/**
 * Brand an adapter-owned reasoning-effort identifier.
 * @param id - the opaque identifier exposed by one model capability.
 * @returns the same string, branded; the input is checked as an opaque string.
 */
export function ReasoningEffortId(id: string): ReasoningEffortId {
  return z.string().brand<'ReasoningEffortId'>().parse(id)
}
