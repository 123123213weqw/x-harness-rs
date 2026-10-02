import {Context as CordisContext} from '@xharness/cordis'
import {isObjectRecord} from '../shared/runtime-types'
import type {GatewayContext} from './contracts'
export function cordisGatewayContext(value: GatewayContext): CordisContext {
  if (!CordisContext.is(value)) throw new TypeError('api-gateway: expected a Cordis context')
  return value
}
function isGatewayContext(value: unknown): value is GatewayContext {
  if (!isObjectRecord(value) || !CordisContext.is(value)) return false
  const typert: unknown = value.typert
  const reflect: unknown = value.reflect
  if (!isObjectRecord(typert) || !isObjectRecord(reflect) || !isObjectRecord(reflect.props)) return false
  const remotes: unknown = typert.remotes
  const contexts: unknown = typert.contexts
  return typeof value.effect === 'function' && typeof value.get === 'function' && typeof value.plugin === 'function'
    && isObjectRecord(remotes) && typeof remotes.register === 'function'
    && isObjectRecord(contexts) && typeof contexts.getClient === 'function'
}
export function gatewayContext(value: unknown): GatewayContext {
  if (!isGatewayContext(value)) throw new TypeError('api-gateway: missing injected Gateway Context')
  return value
}
