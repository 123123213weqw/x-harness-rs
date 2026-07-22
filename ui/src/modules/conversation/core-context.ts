import { Context as CoreContext } from '@xharness/cordis'
import { isObjectRecord } from '../shared/runtime-types'
import type { ISessions } from './types/runtime'

/** Cordis' real brand proves the base constructor, not a fabricated structural SDK. */
export function requireCoreContext(value: unknown): CoreContext {
  if (!CoreContext.is(value)) throw new Error('conversation requires a Cordis Context')
  return value
}
/** Validate the injected service capabilities at their first actual use. */
export function isSessions(value: unknown): value is ISessions {
  if (!isObjectRecord(value) || !isObjectRecord(value.list)) return false
  return typeof value.list.getSnapshot === 'function' && typeof value.list.subscribe === 'function'
    && typeof value.scopeOf === 'function' && typeof value.scope === 'function'
    && typeof value.binding === 'function' && typeof value.open === 'function'
    && typeof value.fork === 'function' && typeof value.provide === 'function'
}
