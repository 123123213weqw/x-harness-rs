/** Production wire root: URL parameters never select a fake transport. */
import type { ConnectionContext as Context } from './context'
import { installConnection } from './install'
import { WebApiClient } from './web-api-client'
import { createWebConnectionRpc } from './rpc'
export * from './public'

export const inject: string[] = []
export function apply(ctx: Context): void {
  installConnection(ctx, new WebApiClient(), createWebConnectionRpc())
}
