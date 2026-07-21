import type { SessionWireEvent } from '../../client-connection/contracts/host/apiproxy/api/sessions'
import { isSessionEvent } from '../contract/wire-event-codec'
import type { Context, ConversationNodeDefinition, SessionEvent } from '../types/runtime'
import { chatNode } from './common'
interface CheckpointState { turn: number; seq: number; time: number; kind: string; message: string }
export interface CheckpointNode extends Omit<CheckpointState, 'kind'> { noticeKind: string; kind: 'run-checkpoint'; step: number }
declare module '../contract/chat-nodes' { interface ChatNodeDataMap { 'run-checkpoint': CheckpointNode } }
export function checkpointState(event: SessionWireEvent): CheckpointState | null {
  if (isSessionEvent(event, 'run/checkpoint') && event.data.notice) return { turn: event.data.turn, seq: event.seq, time: event.time, ...event.data.notice }
  if (isSessionEvent(event, 'turn/end') && event.data.reason.kind === 'max-steps') return { turn: event.data.turn, seq: event.seq, time: event.time, kind: 'limit', message: '已达到本轮步骤硬上限，进度已保存。发送“继续”可启动下一轮；不会重放已完成的工具。' }
  return null
}
export const checkpointDefinition: ConversationNodeDefinition<CheckpointState | null> = {
  kind: 'run-checkpoint', target: 'chat',
  match: event => checkpointState(event) ? { id: String(event.seq), role: 'start' } : null,
  start: (_ctx, match) => checkpointState(match.event), update: ctx => ctx.state,
  publication: () => 'immediate',
  buildViewNode: ctx => ctx.state ? chatNode(ctx, 'run-checkpoint', ctx.state.seq, { ...ctx.state, noticeKind: ctx.state.kind, kind: 'run-checkpoint', step: ctx.start?.location.kind === 'step' ? ctx.start.location.step.step : 0 }) : null,
}
export function registerCheckpointConversationNode(ctx: Context): void { ctx.conversationEvents.register(checkpointDefinition) }
