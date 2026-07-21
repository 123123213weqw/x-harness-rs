import type { Context } from "../types/runtime"
import { registerCheckpointConversationNode } from './checkpoint'
import { registerAssistantConversationNode } from './assistant'
import { registerChatConversationView } from './chat-snapshot-builder'
import { registerCommandConversationNode } from './command'
import { registerCompactionConversationNode } from './compaction'
import { registerUnknownConversationFallback } from './fallback'
import { registerInboxConversationNodes } from './inbox'
import { registerMessageConversationNode } from './message'
import { registerRetryConversationNode } from './retry'
import { registerToolConversationNode } from './tool'
import { registerTurnErrorConversationNode } from './turn-error'
import { registerTurnMaxTokensConversationNode } from './turn-max-tokens'
import { registerTurnTailConversationNode } from './turn-tail'

/**
 * Register the Chat business Definitions and target builder contributed by this package.
 * @param ctx - owning UI Conversation context.
 */
export function registerConversationNodes(ctx: Context): void {
  registerInboxConversationNodes(ctx)
  registerMessageConversationNode(ctx)
  registerAssistantConversationNode(ctx)
  registerToolConversationNode(ctx)
  registerCommandConversationNode(ctx)
  registerCompactionConversationNode(ctx)
  registerRetryConversationNode(ctx)
  registerTurnErrorConversationNode(ctx)
  registerTurnMaxTokensConversationNode(ctx)
  registerCheckpointConversationNode(ctx)
  registerTurnTailConversationNode(ctx)
  registerUnknownConversationFallback(ctx)
  registerChatConversationView(ctx)
}
