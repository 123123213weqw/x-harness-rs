import type { AssistantBlock } from '../types/model'
import type { AssistantChunk } from '../types/wire'
/** The UI-local chunk vocabulary admits file/foreign block starts as opaque. */
export function emptyAssistantBlock(blockType: string): AssistantBlock {
  switch (blockType) {
    case 'text': return { kind: 'text', text: '' }
    case 'reasoning': return { kind: 'reasoning', text: '' }
    case 'tool-call': return { kind: 'tool-call', callId: '', name: '', argsRaw: '' }
    default: return { kind: 'other', block: null }
  }
}
export function isTokenDelta(chunk: AssistantChunk): boolean {
  switch (chunk.type) {
    case 'text-delta': case 'reasoning-delta': return chunk.text !== ''
    case 'tool-call-delta': return chunk.argumentsDelta !== '' || chunk.name !== undefined
    default: return false
  }
}
