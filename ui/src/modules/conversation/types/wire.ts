/** Module-local Host protocol vocabulary; payloads are data, never service implementations. */
import type { TurnEndDataInput } from '../../shared/generated/session-terminal'
export type SessionId = string
export type WorkspaceId = string
export type MessageId = string
export type CommandId = string
export type Branded<Name extends string> = string & { readonly __brand: Name }
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
export interface ImageAttachmentRef { attachmentId: string; mediaType: string; name?: (string) | undefined; bytes: number; width?: (number | null) | undefined; height?: (number | null) | undefined }
export interface ImageAttachmentLimits { maxImageDimension: number; maxImagesPerMessage: number; maxImageBytes: number; maxMessageImageBytes: number; mediaTypes: readonly ImageMediaType[] }
/** Content is extensible wire data; each renderer validates the fields it consumes. */
export type ContentBlock = unknown

export interface RpcError { code: string; message: string; details: Readonly<Record<string, unknown>> }
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError }
export interface SubagentAddress { parentSessionId: SessionId; subagentId: string; mode: 'continuable' | 'detached' }
export interface ToolCallView { card: string; kind?: string | undefined; title?: string | undefined; locations?: readonly { path: string; line?: number | undefined }[] | undefined; [key: string]: unknown }
export interface ToolResultView { card: string; [key: string]: unknown }
export type ToolEventView = { for: 'call'; view: ToolCallView } | { for: 'result'; view: ToolResultView } | { for: 'compaction'; view: Record<string, unknown> }
export type InboxTarget = 'next-turn' | 'next-step'
export interface TodoItem { content: string; status: 'pending' | 'in_progress' | 'completed' }
export interface LlmFailure { message: string; code: string; [key: string]: unknown }
export type LlmRetryEventData = { turn: number; step: number; retryId: string; retry: number; delayMs: number; policyKey: string; provider: string; failure: LlmFailure } & (
  | { mode: 'normal'; maxRetries: number }
  | { mode: 'always' }
)

export interface CompactionCheckpointSource { kind: 'plugin'; plugin: 'compact'; compactionId: string; sourceCommandId?: (CommandId) | undefined }
export type AssistantChunk =
 | { type: 'block-start'; index: number; blockType: string }
 | { type: 'text-delta' | 'reasoning-delta'; index: number; text: string }
 | { type: 'tool-call-delta'; index: number; id: string; name?: (string) | undefined; argumentsDelta: string }
 | { type: 'block-end'; index: number; block: ContentBlock }
 | { type: 'usage'; usage: unknown }
 | { type: 'finish'; reason?: (unknown) | undefined }
export interface SessionEventMap {
 'turn/start': { turn: number }
 'run/checkpoint': { turn: number; notice?: ({ kind: string; message: string }) | undefined }
 'turn/end': TurnEndDataInput
 'step/start': { turn: number; step: number }
 'step/end': { turn: number; step: number; reason?: (unknown) | undefined }
 'assistant/chunk': { turn: number; step: number; chunk: AssistantChunk }
 'assistant/message': { turn: number; step: number; message: { id: string; content: readonly ContentBlock[] }; usage?: (unknown) | undefined; interrupted?: (boolean) | undefined }
 'user/message': { id: string; content: readonly ContentBlock[]; source: { kind: string; [key: string]: unknown } }
 'tool/call': { callId: string; name: string; arguments: string; turn: number; step: number }
 'tool/result': { turn: number; step: number; message: { source: { callId: string }; content: readonly [{ type: 'tool-result'; content: readonly ContentBlock[]; isError?: (boolean) | undefined }, ...ContentBlock[]] }; error?: ({ name: string; code: string }) | undefined; meta?: (unknown) | undefined }
 'tool/code-dispatch-start': { parentCallId: string; rootCallId: string; subCallId: string; name: string; arguments: unknown }
 'tool/code-dispatch': { parentCallId: string; rootCallId: string; subCallId: string; name: string; arguments: unknown; content?: (readonly ContentBlock[]) | undefined; isError?: (boolean) | undefined }
 'command/run': { commandId: string; name: string; args?: (string) | undefined }
 'command/done': { commandId: string; kind: 'success' | 'error'; text?: (string) | undefined; sourceEventSeq?: (number) | undefined }
 'compaction/start': { compactionId: string; sourceCommandId?: (string) | undefined }
 'compaction/end': { compactionId: string; sourceCommandId?: (string) | undefined; error?: (string | null) | undefined }
 'compaction/progress': { compactionId: string; sourceCommandId?: (string) | undefined; progress: unknown }
 'compaction/summary': { compactionId: string; sourceCommandId?: (string) | undefined; summary: readonly ContentBlock[]; shadowedSeqs: readonly number[]; shadowedTokenCount: number }
 'agent/inbox/spliced': { target: InboxTarget; start: number; removedCount?: (number) | undefined; inserted: readonly { id: string }[]; outcome?: ('canceled') | undefined }
 'llm/retry': LlmRetryEventData
 'llm/retry-started': { turn: number; step: number; retryId: string; retry: number }
 'unknown': unknown
}
export type SessionEvent<Type extends keyof SessionEventMap = keyof SessionEventMap> = { [K in Type]: { type: K; seq: number; time: number; data: SessionEventMap[K]; surfaceOp?: unknown; sourceEventSeqs?: readonly number[] | undefined } }[Type]
export interface ContextComposition { systemTokens: number; userTokens: number; assistantTokens: number; toolResultTokens: number; toolDefinitionTokens: number; mcpToolDefinitionTokens: number; protocolTokens: number }
export interface ContextPressureProjection { projectedTokens?: (number) | undefined; pressureTokens?: (number) | undefined; contextWindow?: (number) | undefined; pressureAccuracy?: (string) | undefined; projectedAccuracy?: (string) | undefined; accuracy?: (string) | undefined; phase?: (string) | undefined; composition?: (ContextComposition) | undefined }
export interface TokenUsageProjection { uncachedInputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number }
export interface PermissionSelect { pending?: (boolean) | undefined; activeValue?: (string) | undefined; currentValue: string; options: readonly { value: string; name: string; description?: (string) | undefined }[] }
