import type { ClientContext } from '../conversation/types/runtime'
import type {} from '../conversation/index'
import type { SlotMap } from '../conversation/types/slots'
import { EnvironmentPicker } from './EnvironmentPicker'
import { en, NS, zh } from './locales'

export const inject = ['slots', 'locale']
export const ENVIRONMENT_SLOT = 'conversation.hero.runtimeEnvironment' satisfies keyof SlotMap

/** Owned source-module registration, not a patch of a generated JS bundle. */
export function apply(ctx: Pick<ClientContext, 'slots' | 'locale' | 'effect'>): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'runtime-environment: dictionaries')
  ctx.slots.inject(ENVIRONMENT_SLOT, () =>
    ctx.slots.register({ name: ENVIRONMENT_SLOT, locale: NS }, EnvironmentPicker))
}
