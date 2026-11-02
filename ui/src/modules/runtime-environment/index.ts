import { createElement } from 'react'
import type { ClientContext } from '../conversation/types/runtime'
import type {} from '../conversation/index'
import type { SlotMap } from '../conversation/types/slots'
import { GatewayHeader, GatewayHero, GatewayCloudStatus } from './GatewayEnvironment'
import type { ConnectionHandle } from '../client-connection/install'
import { en, NS, zh, type EnvironmentKey } from './locales'

export const inject = ['slots', 'locale', 'connection']
export const ENVIRONMENT_SLOT = 'conversation.hero.runtimeEnvironment' satisfies keyof SlotMap

/** Owned source-module registration, not a patch of a generated JS bundle. */
export function apply(ctx: Pick<ClientContext, 'slots' | 'locale' | 'effect'> & { get(name: 'connection'): ConnectionHandle }): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'runtime-environment: dictionaries')
  ctx.slots.inject(ENVIRONMENT_SLOT, () =>
    ctx.slots.register({ name: ENVIRONMENT_SLOT, locale: NS }, GatewayHero))
  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register({ name: 'conversation.session.header.actions', id: 'environment-gateway', order: -20, locale: NS }, GatewayHeader))
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register({ name: 'conversation.input.dock', id: 'environment-cloud-status', order: -20, locale: NS }, (props: { t: (key: EnvironmentKey) => string }) =>
      createElement(GatewayCloudStatus, { t: props.t, description: ctx.get('connection').hostDescription })))
}
