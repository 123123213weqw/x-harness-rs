import {Context as CordisContext} from '@xharness/cordis'
import {isObjectRecord} from '../shared/runtime-types'
import type {SettingsContext} from './contracts'
/** Only the real Cordis constructor establishes the superclass ABI. */
export function cordisSettingsContext(value: SettingsContext): CordisContext {
  if (!CordisContext.is(value)) throw new TypeError('ui-settings: expected a Cordis context')
  return value
}
function isOwnedSettingsContext(value: unknown): value is SettingsContext {
  if (!isObjectRecord(value) || !CordisContext.is(value)) return false
  const remote: unknown = value.remote
  return typeof value.effect === 'function' && typeof value.on === 'function' && typeof value.get === 'function'
    && isObjectRecord(remote) && typeof remote.$on === 'function'
}
/** Read the dynamically traced receiver, never the context captured at
 * registration time. Registered injection establishes each service's API. */
export function settingsContext(value: unknown): SettingsContext {
  if (!isOwnedSettingsContext(value)) throw new TypeError('ui-settings: missing injected settings Context')
  return value
}
