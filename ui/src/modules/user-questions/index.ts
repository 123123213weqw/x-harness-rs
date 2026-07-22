/**
 * Web question plugin, browser half: QuestionComposer registered as a
 * selector-routed entry of the conversation-declared composer chain, plus the
 * `question` dictionaries. The selector narrows the owner's currency to the
 * question carrier (matched prop), and the whole behavior surface rides the
 * carrier (domain encoding in contract/slots.ts PendingQuestion); copy rides
 * the standard locale seat. Export discipline: packages/client/AGENTS.md.
 *
 * One entry, two shapes: the composer renders a request that declares a
 * presentation intent as that intent's own surface (`plan-review` → the plan
 * decision card) and every other request as the generic question flow. A
 * separate chain entry per shape would race the same carrier, so the shape
 * choice lives inside this entry — see QuestionComposer.
 */
import type {ClientContext, ComposerChainProps} from './context'
import type { QuestionWait } from './contract/slots'
import { QuestionComposer } from './QuestionComposer'
import { en, zh, type QuestionKey } from './locales'

export { PendingQuestion } from './contract/slots'
export type {
  PlanReview, QuestionAnswer, QuestionComposerProps, QuestionWait,
} from './contract/slots'
export type { QuestionKey } from './locales'

/** Dictionary namespace owned by this plugin. */
const NS = 'question'

/** Required services: the slot registry and the question composer's copy. */
export const inject = ['slots', 'locale']

/** Chain routing: claim the composer while a question wait is pending (pure — owner props only). */
function selectQuestion({ interactions }: ComposerChainProps): QuestionWait | null {
  return interactions.find((i): i is QuestionWait => i.kind === 'question') ?? null
}

/**
 * Client plugin body: register the `question` dictionaries and the question
 * composer into the composer chain. Zero business face — data and verbs live
 * on the matched carrier; t rides the standard locale seat.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-user-questions: dictionaries')

  ctx.slots.inject('conversation.composer', () => ctx.slots.register(
    { name: 'conversation.composer', select: selectQuestion, locale: NS },
    QuestionComposer,
  ))
}
