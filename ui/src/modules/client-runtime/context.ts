/// <reference path="./externals.d.ts" />
import { Service as CordisService, Context as CordisContext } from '@xharness/cordis'
import type { SessionId, ConnectionHandle } from '../client-connection/index'
import type { TypertClientRemote } from './remote-contracts'
import type { SlotRegistry } from './slots'
import type { ISessions } from './contract/sessions'
import type { IWorkspaces } from './contract/workspaces'
import type { ConversationEventRegistry } from './conversation/event-registry'
import type { ConversationViewRegistry } from './conversation/view-registry'

interface Services {
  connection: ConnectionHandle
  slots: SlotRegistry
  sessions: ISessions
  workspaces: IWorkspaces
  conversationEvents: ConversationEventRegistry
  conversationViews: ConversationViewRegistry
}
export interface Fiber { readonly ctx: Context; readonly name?: string; dispose(): Promise<void> }
/** Consumed Cordis boundary: services retain their domain types, and events
 * carry typed caller tuples instead of an untyped JavaScript argument list. */
export interface Context {
  readonly fiber?: Fiber
  readonly remote: TypertClientRemote
  readonly typert: { contexts: {registerClient(name: 'agent', provider: {identity(context: Context): SessionId | undefined}): () => void} }
  readonly reflect: {provide(name: string, value: unknown, options: undefined): void}
  get<K extends keyof Services>(name: K): Services[K] | undefined
  plugin(plugin: (() => void) | (new(context: Context) => object)): Fiber
  effect(factory: () => unknown, label?: string): () => Promise<void>
  extend(properties: Record<PropertyKey, unknown>): Context
  emit<Args extends readonly unknown[]>(name: string, ...args: Args): void
  emit<Args extends readonly unknown[]>(subject: Context, name: string, ...args: Args): void
}
export const Context: {readonly filter: symbol} = CordisContext

/** Typed consuming view, not a replacement for Cordis's intercept-config generic.
 * The getter reads the original tracker-owned ctx on every call; it never pins
 * the constructing context and therefore preserves caller-fiber disposal. */
type ServiceContext = Pick<Context, 'fiber' | 'effect' | 'get'>
function isServiceContext(value: unknown): value is ServiceContext {
  return CordisContext.is(value) && typeof value.effect === 'function' && typeof value.get === 'function'
}
export abstract class Service extends CordisService {
  constructor(ctx: Context, name: string) {
    if (!CordisContext.is(ctx)) throw new Error('runtime: expected a Cordis Context')
    super(ctx, name)
  }
  protected get runtimeCtx(): ServiceContext {
    const value: unknown = this.ctx
    if (!isServiceContext(value)) throw new Error('runtime: invalid Cordis consuming context')
    return value
  }
}
