/** Browser plugin for durable workflow-run Conversation Nodes. */

import type { WorkflowContext, SessionId } from './contracts'
import { WorkflowRunPanel, type WorkflowRunInjected } from './WorkflowRunPanel'
import { en, NS, type WorkflowRunKey, zh } from './locales'
import { workflowRunDefinition } from './workflow-definition'



/** Required services for Definition, keyed renderer, navigation, and copy. */
export const inject = ['conversationEvents', 'slots', 'sessions', 'locale']

/** Register the workflow Definition, dictionary, and keyed Chat renderer. */
export function apply(ctx: WorkflowContext): void {
  ctx.conversationEvents.register(workflowRunDefinition)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workflow-run: dictionaries')
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'workflow-run',
    locale: NS,
    inject: (): WorkflowRunInjected => ({
      openSession: (id: SessionId) => { ctx.sessions.open(id) },
    }),
  }, WorkflowRunPanel))
}
