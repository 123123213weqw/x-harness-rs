import {Context as CoreContext} from '@xharness/cordis'
import {isObjectRecord} from '../shared/runtime-types'
import type {TriggerSessions} from './contracts'
export function requireCoreContext(value: unknown): CoreContext {
  if (!CoreContext.is(value)) throw new Error('input triggers require a Cordis Context')
  return value
}
/** Scope providers are registered runtime services, not unvalidated wire payloads. */
export function isSessions(value: unknown): value is TriggerSessions {
  return isObjectRecord(value) && typeof value.scope === 'function' && typeof value.scopeOf === 'function'
}
