/// <reference path="./externals.d.ts" />
/**
 * Slash trigger plugin, browser half: the InputTriggerService (`ctx.inputTriggers`) owning
 * trigger detection, the candidate menu, and the pick pipeline; MenuView
 * self-registers into the conversation.input.overlay slot. Frozen pipeline
 * contract in ./contract.ts; sources register through ctx.inputTriggers alone.
 */
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type { TriggerContext as ClientContext } from './contracts'
import { InputTriggerService } from './service'
import type { MenuViewInjected } from './slots'
import { MenuView } from './MenuView'
import { en, zh, type MenuKey } from './locales'

export { InputTriggerService } from './service'
export { InputTriggerController } from './controller'
export type { InputTriggerControllerDeps, SourceRoster } from './controller'
export type { MenuViewInjected } from './slots'
export type { MenuViewProps } from './MenuView'
export type { MenuKey } from './locales'
export type {
  ArbitrateKey, ArbitrateOutcome, BeginCommandRequest, CandidateRequest, ClientSessionContext,
  CommandClaim, ConsumeTokenRequest, InsertReferenceRequest, PickOutcome, PickVia, ReferenceCodec,
  ReferenceInsert, InputTriggerCandidate, InputTriggerPick, InputTriggerSource, SubmitEnvelope,
  SubmitImageAttachment, SubmitOutcome, TokenSpan, TriggerChar, TriggerGuard, TriggerPosition,
} from './types'
export type { DetectTrigger, ExactMatch, MenuEvent, MenuReduce, MenuState, TriggerHit } from './core/contract'
export type { InputTriggerServiceContract } from './contract'





/** Namespace owning the candidate-menu copy. */
const MENU_NS = 'slash.menu'

/** Required services: controller resolution reads the session scope tree; the menu copy is localized. */
export const inject = ['sessions', 'locale']

/**
 * Client plugin body: mount the service, then register MenuView into the
 * input overlay once its declarer is up.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.plugin(InputTriggerService)
  ctx.effect(() => ctx.locale.register(MENU_NS, { zh, en }), 'ui-input-trigger: menu dictionaries')
  ctx.inject(['slots', 'inputTriggers', 'sessions'], (scope: ClientContext) => {
    const inputTriggers = scope.inputTriggers
    const sessions = scope.sessions
    scope.slots.inject('conversation.input.overlay', () => scope.slots.register({
      name: 'conversation.input.overlay',
      id: 'slash-menu',
      order: 0,
      locale: MENU_NS,
      inject: (sessionId: string): MenuViewInjected => {
        // Session-scoped slot: resolve this session's controller (the slot
        // frame hands ids, not ctx — the registered id→ctx interchange).
        const actx = sessions.scope(sessionId)
        if (actx === undefined) throw new Error(`ui-input-trigger: session "${String(sessionId)}" resolved no scope`)
        const controller = inputTriggers.sessionOf(actx)
        return {
          menu: controller.menu,
          onPick: (source, index) => { controller.pick(source, index) },
          onDismiss: () => { controller.dismiss() },
        }
      },
    }, MenuView))
  })
}
