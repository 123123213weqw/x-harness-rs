import type { Context } from '../context'
import type { ConversationViewDefinition } from '../contract/conversation'
import { ConversationDefinitionRegistry } from './definition-registry'

/** Runtime registry of per-target Conversation snapshot builders. */
export class ConversationViewRegistry extends ConversationDefinitionRegistry<ConversationViewDefinition> {

  /** @param ctx - owning Client Runtime context. */
  constructor(ctx: Context) {
    super(ctx, 'conversationViews')
  }

  /**
   * Register a uniquely named view builder factory for the caller's lifetime.
   * @param definition - target builder contribution.
   * @returns idempotent disposer.
   */
  register(definition: ConversationViewDefinition): () => void {
    return this.registerDefinition(
      definition.target,
      definition,
      `conversation view target "${definition.target}" is already registered`,
      `conversationViews.register(${JSON.stringify(definition.target)})`,
    )
  }
}
