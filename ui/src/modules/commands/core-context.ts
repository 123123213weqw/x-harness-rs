import {Context as CoreContext} from '@xharness/cordis'
import {isObjectRecord} from '../shared/runtime-types'
import type {CommandContext} from './contracts'

export function requireCoreContext(value: unknown): CoreContext {
  if (!CoreContext.is(value)) throw new Error('commands require a Cordis Context')
  return value
}
/** Capabilities belong to registered services; wire results are decoded by the existing Remote boundary. */
export type CommandRuntimeContext = Pick<CommandContext, 'effect' | 'events' | 'logger'> & {get(name: string): unknown}
function isCommandContext(value: unknown): value is CommandRuntimeContext {
  if (!CoreContext.is(value) || !isObjectRecord(value)) return false
  const events: unknown = value.events, logger: unknown = value.logger
  if (!isObjectRecord(events)) return false
  if ((typeof logger !== 'object' && typeof logger !== 'function') || logger === null) return false
  const warn: unknown = Reflect.get(logger, 'warn')
  return typeof value.effect === 'function' && typeof value.get === 'function'
    && typeof events.dispatch === 'function' && typeof warn === 'function'
}
/** Read this.ctx for every call: Core's service tracker supplies the calling scope. */
export function commandContext(value: unknown): CommandRuntimeContext {
  if (!isCommandContext(value)) throw new Error('commands context capabilities unavailable')
  return value
}
/** Namespace access itself enforces the caller's inject policy. Defer it until
 * an execution actually needs it: contribution registration/decorating only
 * owns an effect and never required remote.commands in the frozen service.
 */
export function commandRemote(value: unknown): CommandContext['remote']['commands'] {
  if (!CoreContext.is(value) || !isObjectRecord(value)) throw new Error('commands require a Cordis Context')
  const remote: unknown = value.remote
  if (!isObjectRecord(remote)) throw new Error('commands Remote unavailable')
  const commands: unknown = remote.commands
  if (!isCommandsRemote(commands)) throw new Error('commands Remote unavailable')
  return commands
}
function isCommandsRemote(value: unknown): value is CommandContext['remote']['commands'] {
  return isObjectRecord(value) && typeof value.list === 'function' && typeof value.execute === 'function'
}
export function isThenable(value: unknown): boolean {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false
  const then: unknown = Reflect.get(value, 'then')
  return typeof then === 'function'
}

export function isSessions(value: unknown): value is import('./contracts').CommandSessions {
  return isObjectRecord(value) && typeof value.scope === 'function' && typeof value.scopeOf === 'function' && typeof value.subagentAddress === 'function'
}
