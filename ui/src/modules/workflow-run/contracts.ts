import type { ClientContext } from '../views-types'
import type { WorkflowRunChatData } from './workflow-definition'
export type SessionId = string
export type WorkflowAgentOutcome = 'completed' | 'cancelled' | 'failed'
export type WorkflowStopReason = 'completed' | 'cancelled' | 'error'
export interface ToolWorkflowAgentStartData { runId: string; seq: number; label: string; phase?: string; childId: string }
export interface ToolWorkflowAgentEndData { runId: string; seq: number; outcome: WorkflowAgentOutcome }
export type WorkflowEvent =
  | { type: 'tool-workflow/run-start'; seq: number; data: { runId: string; name: string } }
  | { type: 'tool-workflow/agent-start'; seq: number; data: ToolWorkflowAgentStartData }
  | { type: 'tool-workflow/agent-end'; seq: number; data: ToolWorkflowAgentEndData }
  | { type: 'tool-workflow/run-end'; seq: number; data: { runId: string; stopReason: WorkflowStopReason } }
  | { type: 'other'; seq: number; data: unknown }
export type ConversationLocation =
  | { kind: 'step'; step: { status: string }; turn: { status: string } }
  | { kind: 'turn'; turn: { status: string } }
  | { kind: 'unresolved' }
export interface ConversationNodeContext<State> {
  state?: State; start?: { event: WorkflowEvent; location: ConversationLocation }; key: string; id: string
}
export interface ChatConversationViewNode {
  key: string; kind: 'workflow-run'; id: string; target: 'chat'; anchorSeq: number
  location: ConversationLocation; visibility: 'visible'; data: WorkflowRunChatData
}
export interface ConversationNodeDefinition<State> {
  kind: string; target: 'chat'
  match(event: WorkflowEvent): { id: string; role: 'start' | 'update' } | null
  start(context: unknown, match: { event: WorkflowEvent }): State
  update(context: { state: State }, match: { event: WorkflowEvent }): State
  buildViewNode(context: ConversationNodeContext<State>): ChatConversationViewNode | null
}
export interface SessionListState {
  ids: readonly string[]
  byId: Readonly<Record<string, { origin?: string; parentId?: string; running: boolean }>>
}
export interface WorkflowContext extends Omit<ClientContext, 'conversationEvents'> {
  conversationEvents: { register<State>(definition: ConversationNodeDefinition<State>): void }
  sessions: { open(id: string): void }
}
