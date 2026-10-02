import { z } from 'zod'
import type { ChatNode, ChatNodeDataMap, ChatNodeKind } from './chat-nodes'
import type { ChatConversationViewNode, ContentBlock, ToolCallBlock } from '../types/runtime'

const n = z.number(), s = z.string(), nullable = s.nullable()
const base = { seq: n, time: n }
const attachment = z.looseObject({ attachmentId: s, mediaType: s, bytes: n, name: s.optional(), width: n.nullable().optional(), height: n.nullable().optional() })
const content = z.unknown()
const callView = z.looseObject({ card: s, kind: s.optional(), title: s.optional(), locations: z.array(z.object({ path: s, line: n.optional() })).optional() }).nullable()
const resultView = z.looseObject({ card: s }).nullable()
const callBase = { ...base, callId: s, callView }
const tool: z.ZodType<ToolCallBlock> = z.lazy(() => z.union([
  z.looseObject({ callId: s, callView, time: n, name: s, argsRaw: s, turn: n, step: n, subCalls: z.array(tool) }).refine(value => !('kind' in value)),
  z.looseObject({ ...callBase, kind: z.literal('tool-result'), call: z.object({ name: s, argsRaw: s }).nullable(), callTime: n.nullable(),
    content: z.array(content), isError: z.boolean(), error: z.object({ name: s, code: s }).optional(), meta: z.unknown().optional(), resultView, subCalls: z.array(tool),
  }),
]))
const blocks = z.array(z.union([
  z.looseObject({ kind: z.enum(['text', 'reasoning']), text: s }),
  z.looseObject({ kind: z.literal('image'), attachment }),
  z.looseObject({ kind: z.literal('tool-call'), callId: s, name: s, argsRaw: s }),
  z.looseObject({ kind: z.literal('other'), block: z.unknown() }),
]))
const finalAssistant = z.looseObject({ ...base, kind: z.literal('assistant'), turn: n, step: n, blocks,
  messageId: s.optional(), usage: z.unknown().optional(), interrupted: z.literal(true).optional(),
  provenance: z.object({ provider: s, model: s }).optional(),
  requestConfig: z.looseObject({ provider: s, model: s, purpose: s.optional(), thinking: s.optional(), reasoningEffort: s.optional(), temperature: n.optional(), maxTokens: n.optional(), stop: z.array(s).optional() }).optional(),
  timing: z.object({ stepStartTime: n.nullable(), firstTokenTime: n.nullable(), completedTime: n }).optional(),
})
const assistant = z.looseObject({ status: z.enum(['running', 'settled', 'interrupted']), turn: n, step: n, blocks, time: n, usage: z.unknown().optional(), finalNode: finalAssistant.optional() })
const command = z.looseObject({ ...base, kind: z.literal('command'), commandId: s, name: nullable, args: nullable,
  outcome: z.looseObject({ kind: z.enum(['success', 'error']), text: s.optional(), sourceEventSeq: n.optional() }).nullable(),
})
const progress = z.looseObject({ stage: z.enum(['preparing', 'summarizing', 'splitting', 'merging', 'retrying', 'paused', 'validating', 'committing']),
  calls: n, completedParts: n, splits: n, retries: n, delayMs: n.nullish(), inputTokensBefore: n.nullish(), inputTokensAfter: n.nullish(),
}).optional()
const compaction = z.union([
  z.looseObject({ ...base, kind: z.literal('compaction'), summary: nullable, summaryEventSeq: n.nullable(), shadowedItemCount: n.nullable(), shadowedTokenCount: n.nullable(), progress, startedAt: n.optional(), endedAt: n.optional() }),
  z.looseObject({ ...base, kind: z.literal('compaction'), status: z.enum(['running', 'failed']), progress, progressTime: n.optional(), error: nullable, endedAt: n.optional() }),
])
const retryBase = { ...base, kind: z.literal('model-retry'), turn: n, step: n, retryId: s, retry: n, retryState: z.enum(['scheduled', 'started', 'cancelled']) }
const retryFacts = { delayMs: n, policyKey: s, provider: s, failure: z.looseObject({ message: s, code: s }) }
const retry = z.union([
 z.looseObject({ ...retryBase, ...retryFacts, mode: z.literal('normal'), maxRetries: n }),
 z.looseObject({ ...retryBase, ...retryFacts, mode: z.literal('always') }),
 z.looseObject({ ...retryBase, partial: z.literal(true) }),
])
const schemas: { [K in ChatNodeKind]: z.ZodType<ChatNodeDataMap[K]> } = {
  user: z.looseObject({ ...base, kind: z.literal('user'), content: z.array(content), source: z.unknown(), referenceLabels: z.array(s).optional() }),
  steering: z.looseObject({ ...base, kind: z.literal('steering'), messageId: s, content: z.array(content), source: z.unknown(), referenceLabels: z.array(s).optional() }),
  context: z.looseObject({ ...base, kind: z.literal('context'), content: z.array(content), source: z.unknown(), provenance: z.object({ role: z.enum(['inject', 'recall']), label: nullable }), form: z.enum(['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall']).nullable() }),
  command,
  compaction,
  'manual-compaction': z.looseObject({ command, compaction: compaction.nullable() }),
  'assistant-step': assistant,
  'tool-call': z.looseObject({ root: tool }),
  'model-retry': z.looseObject({ attempts: z.array(retry), current: retry }),
  'turn-error': z.looseObject({ ...base, kind: z.literal('turn-error'), turn: n, step: n, message: s, code: s.optional() }),
  'turn-max-tokens': z.looseObject({ ...base, kind: z.literal('turn-max-tokens'), turn: n, step: n }),
  unknown: z.looseObject({ ...base, kind: z.literal('unknown'), type: s, data: z.unknown() }),
  'run-checkpoint': z.looseObject({ ...base, kind: z.literal('run-checkpoint'), turn: n, step: n, noticeKind: s, message: s }),
  'turn-tail': z.looseObject({ ...base, turn: n, closing: assistant.extend({ finalNode: finalAssistant }).nullable(), branchUnavailable: z.boolean(), ttftMs: n.optional(), tokensPerSecond: n.optional() }),
}
function knownKind(value: string): value is ChatNodeKind { return Object.hasOwn(schemas, value) }

/** Validate a foreign published node without cloning a valid owner's immutable payload. */
export function isChatNode(node: ChatConversationViewNode | undefined): node is ChatNode {
  return node !== undefined && knownKind(node.kind) && schemas[node.kind].safeParse(node.data).success
}

/** Location store values are owner-decoded rather than unsound generic getters. */
export function isChatData<K extends ChatNodeKind>(kind: K, value: unknown): value is ChatNodeDataMap[K] {
 return schemas[kind].safeParse(value).success
}
