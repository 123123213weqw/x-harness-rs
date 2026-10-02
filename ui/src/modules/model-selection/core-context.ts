import { Context as CoreContext } from '@xharness/cordis'
import { isObjectRecord } from '../shared/runtime-types'
import type { ModelClientContext, ClientSessions } from './contracts'
export function requireCoreContext(value: unknown): CoreContext {
  if (!CoreContext.is(value)) throw new Error('model-selection requires a Cordis Context')
  return value
}
export function isSessions(value: unknown): value is ClientSessions {
  return isObjectRecord(value) && typeof value.scope === 'function' && typeof value.subagentAddress === 'function'
}
export function isConnection(value: unknown): value is { api: { sessions: import('./contracts').SessionsWire } } {
  return isObjectRecord(value) && isObjectRecord(value.api) && isObjectRecord(value.api.sessions)
    && typeof value.api.sessions.models === 'function' && typeof value.api.sessions.selectModel === 'function'
}
export function isConversation(value: unknown): value is { blocks: { set(sessionId: string, block: { reason: string } | undefined): void } } {
  return isObjectRecord(value) && isObjectRecord(value.blocks) && typeof value.blocks.set === 'function'
}
