import {isTrajectoryEvent, promptSchema, requestConfigSchema} from './wire-event-codec'
import {isObjectRecord} from '../shared/runtime-types'
import type { Context } from './contracts'
import type {
  ConversationMatch, ConversationNodeDefinition, ConversationPromptSnapshot,
  RequestPromptChange, AssistantRequestConfig,
} from '../client-runtime/index'
import { trajectoryNode } from './trajectory-definition-common'
import type { TrajectoryRequestHeaderState } from './trajectory-contract'

function isRequestConfig(value:unknown):value is AssistantRequestConfig {
  return requestConfigSchema.safeParse(value).success && isObjectRecord(value)
    && ['purpose','thinking','reasoningEffort','temperature','maxTokens','stop'].every(key => !(key in value) || value[key] !== undefined)
}

function isPromptSnapshot(value:unknown):value is ConversationPromptSnapshot {
  return promptSchema.safeParse(value).success && isObjectRecord(value) && isRequestConfig(value.config)
}

function requestPrompt(match: ConversationMatch): ConversationPromptSnapshot {
  if (!isTrajectoryEvent(match.event, 'request/header')) {
    throw new Error('trajectory-request-header start requires request/header')
  }
  const header = match.event.data.header
  const config:unknown = header.config
  if (!isRequestConfig(config)) throw new TypeError('trajectory: invalid request configuration')
  return {
    config,
    system: header.system ?? '',
    tools: header.tools ?? [],
  }
}

function promptChange(
  previous: ConversationPromptSnapshot | undefined,
  prompt: ConversationPromptSnapshot,
  match: ConversationMatch,
): RequestPromptChange | undefined {
  if (!isTrajectoryEvent(match.event, 'request/header')) return undefined
  if (previous === undefined && match.event.data.reason !== 'initial') return undefined
  const systemChanged = previous !== undefined && previous.system !== prompt.system
  const toolsChanged = previous !== undefined
    && JSON.stringify(previous.tools) !== JSON.stringify(prompt.tools)
  if (previous !== undefined && !systemChanged && !toolsChanged) return undefined
  return {
    seq: match.event.seq,
    time: match.event.time,
    kind: previous === undefined
      ? 'initial'
      : systemChanged && toolsChanged
        ? 'system-and-tools'
        : systemChanged ? 'system' : 'tools',
    ...(previous === undefined ? {} : { previous }),
  }
}

const trajectoryRequestHeaderDefinition: ConversationNodeDefinition<TrajectoryRequestHeaderState> = {
  kind: 'trajectory-request-header',
  target: 'trajectory',
  match: event => isTrajectoryEvent(event, 'request/header')
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match, reader) => {
    const prompt = requestPrompt(match)
    const previousState = reader.previous('trajectory-request-header')?.state
    const previousPrompt = isObjectRecord(previousState) ? previousState.prompt : undefined
    const previous = isPromptSnapshot(previousPrompt) ? previousPrompt : undefined
    const change = promptChange(previous, prompt, match)
    return {
      seq: match.event.seq,
      time: match.event.time,
      prompt,
      location: match.location,
      ...(change === undefined ? {} : { change }),
    }
  },
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : trajectoryNode(context, context.state.seq, {
      kind: 'request-header',
      header: context.state,
    }),
}

/**
 * Register Trajectory request-header facts.
 *
 * @param ctx - Plugin context receiving the Definition.
 */
export function registerTrajectoryRequestHeaderDefinition(ctx: Context): void {
  ctx.conversationEvents.register(trajectoryRequestHeaderDefinition)
}
