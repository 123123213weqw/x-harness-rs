import type { AssistantBlock } from '../types/runtime'

/** Partial tool arguments do not render a settled tool card prematurely. */
export function preparingCall(block: AssistantBlock): boolean {
  if (block.kind !== 'tool-call' || !block.name) return false
  if (!block.argsRaw || block.argsRaw.length > 8192) return true
  try {
    const value: unknown = JSON.parse(block.argsRaw)
    return value === null || typeof value !== 'object' || Array.isArray(value)
  } catch { return true }
}
