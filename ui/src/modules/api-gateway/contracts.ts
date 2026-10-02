/** Client-only gateway protocol. All business values retain unknown until their strict codec parses them. */
export type TypertDisposer = () => void | Promise<void>
export type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: {code: string; message: string; details?: unknown} }
export type TypertCodec = { mode: 'strict'; schema: {parse(value: unknown): unknown} } | { mode: 'opaque' }
export interface InvocationDescriptor {
  namespace: string
  method: string
  parameters: readonly {wire: string; source?: string; lookup?: string; codec: TypertCodec}[]
  result: TypertCodec
  invocation: {kind: 'direct'} | {kind: 'context'; context: string; wire: string; codec: TypertCodec}
  scope?: {context: string; wire: string}
  cancellation?: unknown
}
export interface TypertRemoteContribution {package: string; descriptors: readonly InvocationDescriptor[]}
export interface GatewayContext {
  effect(effect: () => (() => void) | (() => Promise<void>), label: string): (() => void)
  effect(effect: () => Promise<TypertDisposer>, label: string): PromiseLike<unknown> & (() => Promise<void>)
  typert: {
    remotes: {register(contribution: TypertRemoteContribution): TypertDisposer}
    contexts: {getClient(name: string): {identity(context: GatewayContext): unknown} | undefined}
  }
  reflect: {props: Record<string, {type?: string} | undefined>}
  get(name: 'connection'): ConnectionHandle | undefined
  get(name: string): unknown
  plugin(plugin: {name: string; apply(context: GatewayContext): void}): PromiseLike<unknown> & {dispose(): Promise<void>}
}
export interface ConnectionHandle {
  rpc: {call(path: '/api', endpoint: string, params: {args: Record<string, unknown>}, signal: AbortSignal): Promise<RemoteResult<unknown>>}
}
export interface TypertClientRemote {
  $mount(contribution: TypertRemoteContribution): Promise<TypertDisposer>
  $on(event: string, listener: (...args: unknown[]) => unknown): () => void
  $dispatch(event: string, args: readonly unknown[]): void
}
