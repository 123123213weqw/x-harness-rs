/**
 * Message feedback plugin, browser half: the Like/Dislike entry in the
 * conversation.chat.assistant-actions strip. One MessageFeedbackController per
 * Session backs every message control in that Session, so a single list read
 * seeds the whole transcript. Mutations go through the generated
 * messageFeedback Remote; the Host owns per-item compare-and-set.
 * @module @xharness/dsh-client-ui-message-feedback/client
 */

import type { FeedbackContext, SessionId } from './contracts'
// Type-only: pulls the generated Remote API and ctx.remote merge through the Client assembly boundary.
// Type-only: pulls the ui-conversation SlotMap merge (the assistant-actions entry).
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import { MessageFeedbackController } from './controller'
import { MessageFeedbackActions } from './MessageFeedbackActions'
import type { MessageFeedbackInjected } from './slots'
import { en, zh } from './locales'

export type {
  MessageFeedbackActionResult, MessageFeedbackStatus, MessageFeedbackView, MessageFeedbackRemote,
} from './controller'
export type { MessageFeedbackActionProps, MessageFeedbackInjected } from './slots'
export type { MessageFeedbackKey } from './locales'

/** Dictionary namespace owned by this plugin. */
const NS = 'feedback'

/** Required services: the slot registry, the Remote namespace, and the copy. */
export const inject = ['slots', 'remote', 'remote.messageFeedback', 'locale']

/**
 * Client plugin body: the per-message feedback entry and its per-session
 * object layer.
 * @param ctx - client root context.
 */
export function apply(ctx: FeedbackContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-message-feedback: dictionaries')

  const controllers = new Map<SessionId, MessageFeedbackController>()
  const controllerFor = (sessionId: SessionId): MessageFeedbackController => {
    let controller = controllers.get(sessionId)
    if (controller === undefined) {
      controller = new MessageFeedbackController(ctx.remote.messageFeedback, sessionId)
      controllers.set(sessionId, controller)
    }
    return controller
  }

  // A reconnect can only invalidate what was already read; a cold Session
  // stays cold until something asks for it.
  ctx.on('connection/reset', () => {
    for (const controller of controllers.values()) {
      if (controller.getSnapshot().status !== 'cold') void controller.resync()
    }
  })

  ctx.slots.inject('conversation.chat.assistant-actions', () => {
    const dispose = ctx.slots.register({
      name: 'conversation.chat.assistant-actions',
      id: 'feedback',
      order: 10,
      locale: NS,
      inject: (sessionId: SessionId): MessageFeedbackInjected => {
        const controller = controllerFor(sessionId)
        return {
          hooks: { feedback: controller },
          ensure: () => controller.ensure(),
          rate: (messageId, rating, note) => controller.rate(messageId, rating, note),
          toggle: (messageId, rating) => controller.toggle(messageId, rating),
          clearNote: messageId => controller.clearNote(messageId),
          clear: messageId => controller.clear(messageId),
        }
      },
    }, MessageFeedbackActions)
    return () => {
      dispose()
      for (const controller of controllers.values()) controller.dispose()
      controllers.clear()
    }
  })
}
