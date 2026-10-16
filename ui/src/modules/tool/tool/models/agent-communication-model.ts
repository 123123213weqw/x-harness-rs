import type { ToolCallBlock } from '../../types'
import { isRecord, isUnknownArray } from '../../value-guards'
import { resultText, type ToolRowState } from './tool-call-model'

export type AgentCommunicationPhase = 'sending' | 'queued' | 'stop-requested' | 'failed' | 'unknown' | 'unconfirmed'
type Action = 'start' | 'send' | 'stop' | 'revert'
export interface AgentCommunicationModel {
  action: Action
  target: string | null
  message: string
  source: string | null
  checkpoint: number | null
  messageId: string | null
  phase: AgentCommunicationPhase
  state: ToolRowState
  output: string | null
}
function parse(text: string): unknown {
  try { const value: unknown = JSON.parse(text); return value } catch { return undefined }
}
function record(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !isUnknownArray(value)
}
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}
/** Read only explicit Host acknowledgements, never an assistant's narrative.
 * The current tool pipeline wraps the receipt in ToolResult.content. Legacy
 * direct receipts are supported too. Truncated/failed envelopes fail closed.
 */
function receipt(output: string): Record<string, unknown> | null {
  let value = parse(output)
  if (!record(value) || value.ok !== true || (value.truncated !== undefined && value.truncated !== false)) return null
  if (typeof value.content === 'string') {
    value = parse(value.content)
    if (!record(value) || value.ok !== true || (value.truncated !== undefined && value.truncated !== false)) return null
  }
  return value
}
export function agentCommunicationModel(toolName: string, block: ToolCallBlock): AgentCommunicationModel | null {
  if (toolName !== 'agent') return null
  const done = 'kind' in block
  const args = parse((done ? block.call?.argsRaw : block.argsRaw) ?? '')
  if (!record(args)) return null
  const action = args.action
  if (action !== 'start' && action !== 'send' && action !== 'stop' && action !== 'revert') return null
  const checkpoint = action === 'revert' && typeof args.checkpoint_seq === 'number' && Number.isSafeInteger(args.checkpoint_seq) && args.checkpoint_seq >= 0 ? args.checkpoint_seq : null
  const target = action === 'start' ? text(args.label) : text(args.agent_id)
  const message = text(action === 'start' ? args.task : args.message) ?? ''
  const output = done ? resultText(block) || null : null
  const ack = output === null ? null : receipt(output)
  const ackTarget = ack === null ? null : text(ack.agent_id)
  const messageId = ack === null ? null : text(ack.message_id)
  // An acknowledgement for another child is not evidence for this call.
  const matches = ackTarget !== null && (action === 'start' || (action === 'revert' ? ack !== null && text(ack.source_agent_id) === target && checkpoint !== null && ack.checkpoint_seq === checkpoint && ack.filesystem_rollback === false && ackTarget !== target : ackTarget === target))
  let phase: AgentCommunicationPhase = 'sending'
  if (done) {
    if (block.error?.code === 'OUTCOME_UNKNOWN' || block.error?.code === 'interrupted') phase = 'unknown'
    else if (block.isError) phase = 'failed'
    else if (matches && ack !== null && action === 'stop' && ack.accepted === true) phase = 'stop-requested'
    else if (matches && ack !== null && action !== 'stop' && ack.status === 'accepted' && messageId !== null) phase = 'queued'
    else phase = 'unconfirmed'
  }
  const state: ToolRowState = phase === 'sending' ? 'running'
    : phase === 'failed' ? 'error'
      : phase === 'unknown' || phase === 'unconfirmed' ? 'stopped' : 'ok'
  return { action, target: (action === 'start' || action === 'revert') && matches ? ackTarget : target, message,
    source: action === 'revert' ? target : null, checkpoint,
    messageId: phase === 'queued' ? messageId : null, phase, state, output }
}

/** Keep the status visible outside the clipped message preview. Full message
 * and stable identities remain in the expandable body; no extra RPC/polling.
 */
export function agentCommunicationCopy(model: AgentCommunicationModel, chinese: boolean) {
  const phases: Record<AgentCommunicationPhase, string> = chinese
    ? { sending: '发送中', queued: '已入队', 'stop-requested': '已请求停止', failed: '工具失败', unknown: '状态未知', unconfirmed: '未确认' }
    : { sending: 'Sending', queued: 'Queued', 'stop-requested': 'Stop requested', failed: 'Tool failed', unknown: 'Outcome unknown', unconfirmed: 'Unconfirmed' }
  const titles: Record<Action, string> = chinese
    ? { start: '创建子 Agent', send: '发送给 Agent', stop: '停止 Agent', revert: '纠偏子 Agent' }
    : { start: 'Start agent', send: 'Message to agent', stop: 'Stop agent', revert: 'Correct agent' }
  const target = model.target ?? (chinese ? '目标待确认' : 'Target unconfirmed')
  const shortTarget = target.length > 24 ? target.slice(0, 12) + '…' + target.slice(-8) : target
  const preview = model.message.replace(/\s+/g, ' ').slice(0, 160)
  const note = model.phase === 'queued'
    ? chinese ? 'Host 已接受并入队；不代表子 Agent 已读取或完成。' : 'Accepted into the Host inbox; not proof of reading or completion.'
    : model.phase === 'stop-requested'
      ? chinese ? '已接受停止请求；不代表已经停止。' : 'Stop request accepted; not proof the agent has stopped.'
      : model.phase === 'sending'
        ? chinese ? '等待 Host 回执。' : 'Waiting for a Host acknowledgement.'
        : chinese ? '未确认投递结果；不能据此断言消息没有发送。' : 'Delivery is unconfirmed; this does not prove the message was not sent.'
  return {
    title: titles[model.action],
    summary: preview === '' ? shortTarget : `${shortTarget} · ${preview}`,
    status: phases[model.phase],
    body: `${model.source === null ? '' : `${chinese ? '原 Agent' : 'Source agent'}: ${model.source} · ${chinese ? '检查点' : 'Checkpoint'}: ${model.checkpoint ?? '?'}\n${chinese ? '仅回推上下文，不回滚文件。' : 'Context branch only; files are not rolled back.'}\n`}${chinese ? '目标' : 'Target'}: ${target}\n${model.messageId === null ? '' : `${chinese ? '消息 ID' : 'Message ID'}: ${model.messageId}\n`}\n${model.message}\n\n${note}`,
  }
}
