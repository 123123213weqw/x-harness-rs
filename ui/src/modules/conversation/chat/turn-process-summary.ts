import type { ChatConversationViewNode } from '../types/runtime'
import { isChatNode } from '../contract/chat-node-codec'

const metadata = new WeakMap<ChatConversationViewNode, { calls: readonly string[]; thoughts: number }>()

/** Loaded-window counts, not another transcript or task/step completion store. */
export function turnProcessCounts(keys: readonly string[], get: (key: string) => ChatConversationViewNode | undefined): { tools: number; thoughts: number } {
  const calls = new Set<string>()
  let thoughts = 0
  for (const key of keys) {
    const node = get(key)
    if (node === undefined) continue
    let cached = metadata.get(node)
    if (cached === undefined) {
      if (!isChatNode(node)) continue
      const ids = new Set<string>()
      const count = node.kind === 'assistant-step' ? node.data.blocks.filter(block => block.kind === 'reasoning').length : 0
      const location = node.location
      const scope = location?.kind === 'step' ? `${location.turn.turn}:${location.step.step}` : location?.kind === 'turn' ? `${location.turn.turn}:turn` : 'window'
      if (node.kind === 'tool-call') {
        const stack = [node.data.root]
        for (let call = stack.pop(); call !== undefined; call = stack.pop()) {
          if (ids.has(call.callId)) continue
          ids.add(call.callId)
          stack.push(...call.subCalls)
        }
      }
      cached = { calls: [...ids].map(id => `${scope}:${id}`), thoughts: count }
      metadata.set(node, cached)
    }
    thoughts += cached.thoughts
    for (const id of cached.calls) calls.add(id)
  }
  return { tools: calls.size, thoughts }
}
