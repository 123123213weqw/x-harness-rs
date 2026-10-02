import type { CommandExecution } from '../client-connection/contracts/interaction/commands/types'
import type { ContentBlock, SessionId } from '../client-connection/index'
export type { RemoteResult } from '../api-gateway/contracts'
import type { RemoteResult } from '../api-gateway/contracts'
export interface TypertClientRemote {
  commands: {execute(sessionId: SessionId, line: string, images: readonly ContentBlock[]): Promise<RemoteResult<CommandExecution | undefined>>}
  $dispatch(name: string, args: readonly unknown[]): void
}
/** Scope APIs are present on the inherited Cordis Remote receiver; only the
 * scoped commands call is consumed by this runtime. */
export type TypertRemoteScopeApi<Scope extends string> = Scope extends 'agent' ? {
  commands: {execute(line: string, images: readonly ContentBlock[]): Promise<RemoteResult<CommandExecution | undefined>>}
} : object
export interface TypertContext<T> {readonly identity: T}
export interface TypertContextMap {}
