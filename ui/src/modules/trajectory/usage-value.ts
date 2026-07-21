import {isObjectRecord} from '../shared/runtime-types'
/** Token counters are opaque at the carrier; read only present numeric fields.
 * No schema-less generic promise, coercion, mutation or stripping foreign keys. */
export interface UsageValue {
 inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number
}
export function usageValue(value: unknown): UsageValue | undefined {
 if (!isObjectRecord(value)) return undefined
 return {
  ...(typeof value.inputTokens !== 'number' ? {} : {inputTokens:value.inputTokens}),
  ...(typeof value.outputTokens !== 'number' ? {} : {outputTokens:value.outputTokens}),
  ...(typeof value.cacheReadTokens !== 'number' ? {} : {cacheReadTokens:value.cacheReadTokens}),
  ...(typeof value.cacheWriteTokens !== 'number' ? {} : {cacheWriteTokens:value.cacheWriteTokens}),
  ...(typeof value.reasoningTokens !== 'number' ? {} : {reasoningTokens:value.reasoningTokens}),
 }
}
