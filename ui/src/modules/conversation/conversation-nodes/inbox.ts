import { isObjectRecord } from '../../shared/runtime-types'
import { isUnknownArray } from '../wire-guards'
import { isSessionEvent } from '../contract/wire-event-codec'
import type { Context } from "../types/runtime"
import type {
  ConversationNodeDefinition, ConversationPreviousContext,
} from "../types/runtime"
import type { InboxTarget } from "../types/wire"

interface InboxIdentity {
  readonly id: string
}

interface InboxSplice {
  readonly target: InboxTarget
  readonly start: number
  readonly removedCount?: (number) | undefined
  readonly inserted: readonly InboxIdentity[]
  readonly outcome?: ('canceled') | undefined
}

/** Cumulative state after one durable inbox splice. */
export interface InboxState {
  readonly pending: readonly InboxIdentity[]
  readonly claimed: ReadonlySet<string>
}

function applySplice(
  previous: ConversationPreviousContext<unknown> | undefined,
  splice: InboxSplice,
): InboxState {
  const old = isInboxState(previous?.state) ? previous.state : undefined
  const pending = [...(old?.pending ?? [])]
  const claimed = new Set(old?.claimed ?? [])
  const removed = pending.splice(splice.start, splice.removedCount ?? 0, ...splice.inserted)
  for (const identity of splice.inserted) claimed.delete(identity.id)
  if (splice.target === 'next-step' && splice.outcome !== 'canceled') {
    for (const identity of removed) claimed.add(identity.id)
  }
  return { pending, claimed }
}

function inboxDefinition(target: InboxTarget): ConversationNodeDefinition<InboxState> {
  const kind = `inbox-${target}`
  return {
    kind,
    match: event => isSessionEvent(event, 'agent/inbox/spliced')
      && event.data.target === target
      ? { id: String(event.seq), role: 'start' }
      : null,
    start: (_context, match, reader) => {
      if (!isSessionEvent(match.event, 'agent/inbox/spliced')) throw new Error(`${kind} start requires agent/inbox/spliced`)
      return applySplice(reader.previous(kind), match.event.data)
    },
    update: context => context.state,
    publication: () => 'none',
  }
}

/** Cumulative next-turn inbox splice Definition. */
export const nextTurnInboxDefinition = inboxDefinition('next-turn')

/** Cumulative next-step inbox splice Definition used to classify steering. */
export const nextStepInboxDefinition = inboxDefinition('next-step')

/**
 * Register the two durable Inbox-state contributions.
 * @param ctx - owning UI Conversation context.
 */
export function registerInboxConversationNodes(ctx: Context): void {
  ctx.conversationEvents.register(nextTurnInboxDefinition)
  ctx.conversationEvents.register(nextStepInboxDefinition)
}

function isUnknownSet(value: unknown): value is Set<unknown> { return value instanceof Set }
export function isInboxState(value: unknown): value is InboxState {
 return isObjectRecord(value) && isUnknownArray(value.pending)
  && value.pending.every(item => isObjectRecord(item) && typeof item.id === 'string')
  && isUnknownSet(value.claimed) && Array.from(value.claimed).every(id => typeof id === 'string')
}
