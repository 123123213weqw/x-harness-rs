/// <reference path="./externals.d.ts" />
/**
 * Command UI plugin, browser half: CommandUiRuntime (`ctx.commandUi`) owning the
 * capability-keyed directory cache, the '/' command source, the client
 * contribution registry, and the per-session popupSelect controllers; the
 * popupSelect shell self-registers into conversation.input.overlay with
 * per-session resolution.
 */
import type {CommandContext as ClientContext} from './contracts'
// Type-only: pulls the 'conversation.input.overlay' SlotMap declaration (the
// key's owner) into this program so the overlay registration below typechecks
// against the real declaration — no runtime edge to ui-conversation.
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import { CommandUiRuntime } from './service'
import type { PopupSelectInjected } from './PopupSelectView'
import { PopupSelectView } from './PopupSelectView'
import { en, zh, type CommandKey } from './locales'

export { CommandUiRuntime } from './service'
export { CommandDirectory } from './directory'
export type { CommandDescriptor, DirectoryStatus } from './directory'
export { filterOptions, PopupSelectController } from './popup'
export type { PopupSelectDeps, PopupSpec, PopupState, TokenSegment } from './popup'
export type { PopupSelectInjected, PopupSelectViewProps } from './PopupSelectView'
export type {
  CommandContribution, CommandDecoration, CommandUiContract, CommandUiSpec, SelectConfirmation, SelectOption,
} from './contract'
export type { CommandKey } from './locales'





/** Dictionary namespace owned by this plugin. */
const NS = 'command'

/** Required services: the '/' source registry, session scopes, commands Remote, and locale registry. */
export const inject = ['inputTriggers', 'sessions', 'remote', 'remote.commands', 'locale']

/**
 * Client plugin body: mount the service, then register the popupSelect shell
 * into the input overlay once its declarer is up.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-commands: dictionaries')
  ctx.plugin(CommandUiRuntime)
  ctx.inject(['slots', 'commandUi', 'sessions'], (scope: ClientContext) => {
    const command = scope.commandUi
    const sessions = scope.sessions
    scope.slots.inject('conversation.input.overlay', () => scope.slots.register({
      name: 'conversation.input.overlay',
      id: 'command-popup',
      order: 1,
      locale: NS,
      inject: (sessionId: string): PopupSelectInjected => {
        const actx = sessions.scope(sessionId)
        if (actx === undefined) throw new Error(`ui-commands: session "${String(sessionId)}" resolved no scope`)
        return { popup: command.popupFor(actx) }
      },
    }, PopupSelectView))
  })
}
