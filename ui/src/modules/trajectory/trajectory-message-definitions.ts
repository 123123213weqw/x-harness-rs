import {isObjectRecord} from '../shared/runtime-types'
import {MessageId} from '../client-connection/contracts/llm/llm/brand'
import {isTrajectoryEvent} from './wire-event-codec'
import type { Context } from './contracts'
import type {
  ContextMessageNode, ConversationNodeDefinition,
  SteeringMessageNode, UserMessageNode,
} from '../client-runtime/index'
import {
  contextForm, contextProvenance,
} from './runtime'
import { trajectoryNode } from './trajectory-definition-common'

/* jscpd:ignore-start -- Target-owned Definitions intentionally keep their event
 * state machines independent; see ../../../../../.agents/notes/implemented/
 * architecture/2026-08-09-client-conversation-node-assembly.md. */
interface InboxIdentity {
  readonly id: string
}

interface InboxSplice {
  readonly start: number
  readonly removedCount?: number | undefined
  readonly inserted: readonly InboxIdentity[]
  readonly outcome?: 'canceled' | undefined
}

interface InboxState {
  readonly pending: readonly InboxIdentity[]
  readonly claimed: ReadonlySet<string>
}

function isInboxIdentity(value:unknown):value is InboxIdentity {
  return isObjectRecord(value) && typeof value.id === 'string'
}
function isInboxState(value:unknown):value is InboxState {
  return isObjectRecord(value) && Array.isArray(value.pending) && value.pending.every(isInboxIdentity)
    && value.claimed instanceof Set && Array.from<unknown>(value.claimed).every(id => typeof id === 'string')
}
function inboxState(value:unknown):InboxState | undefined {
  return isInboxState(value) ? value : undefined
}

type MessageNode = UserMessageNode | SteeringMessageNode | ContextMessageNode

function applySplice(
  previous: InboxState | undefined,
  splice: InboxSplice,
): InboxState {
  const pending = [...(previous?.pending ?? [])]
  const claimed = new Set(previous?.claimed ?? [])
  const removed = pending.splice(splice.start, splice.removedCount ?? 0, ...splice.inserted)
  for (const identity of splice.inserted) claimed.delete(identity.id)
  if (splice.outcome !== 'canceled') {
    for (const identity of removed) claimed.add(identity.id)
  }
  return { pending, claimed }
}

const trajectoryInboxDefinition: ConversationNodeDefinition<InboxState> = {
  kind: 'trajectory-inbox-next-step',
  match: event => isTrajectoryEvent(event, 'agent/inbox/spliced')
    && event.data.target === 'next-step'
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match, reader) => {
    if (!isTrajectoryEvent(match.event, 'agent/inbox/spliced')) {
      throw new Error('trajectory-inbox-next-step start requires agent/inbox/spliced')
    }
    return applySplice(
      inboxState(reader.previous('trajectory-inbox-next-step')?.state),
      match.event.data,
    )
  },
  update: context => context.state,
  publication: () => 'none',
}

const trajectoryMessageDefinition: ConversationNodeDefinition<MessageNode> = {
  kind: 'trajectory-input-message',
  target: 'trajectory',
  match: event => isTrajectoryEvent(event, 'user/message')
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match, reader) => {
    if (!isTrajectoryEvent(match.event, 'user/message')) {
      throw new Error('trajectory-input-message start requires user/message')
    }
    const event = match.event
    if (event.data.source.kind !== 'user') {
      return {
        kind: 'context',
        seq: event.seq,
        time: event.time,
        content: event.data.content,
        source: event.data.source,
        provenance: contextProvenance(event.data.source),
        form: contextForm(event.data.source),
      }
    }
    const claimed = inboxState(reader.previous('trajectory-inbox-next-step')?.state)
      ?.claimed.has(String(event.data.id)) === true
    return claimed
      ? {
        kind: 'steering',
        messageId: MessageId(event.data.id),
        seq: event.seq,
        time: event.time,
        content: event.data.content,
        source: event.data.source,
      }
      : {
        kind: 'user',
        seq: event.seq,
        time: event.time,
        content: event.data.content,
        source: event.data.source,
      }
  },
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : trajectoryNode(context, context.state.seq, { kind: 'node', node: context.state }),
}
/* jscpd:ignore-end */

/**
 * Register Trajectory-owned inbox classification and message records.
 *
 * @param ctx - Plugin context receiving the Definitions.
 */
export function registerTrajectoryMessageDefinitions(ctx: Context): void {
  ctx.conversationEvents.register(trajectoryInboxDefinition)
  ctx.conversationEvents.register(trajectoryMessageDefinition)
}
