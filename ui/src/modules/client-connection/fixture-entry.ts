/** Test/preview-only wire root; never admitted by a production build. */
import type { ConnectionContext as Context } from './context'
import { installConnection } from './install'
import { FixtureApiClient } from './fixture'
export * from './public'

export const inject: string[] = []
export function apply(ctx: Context): void {
  const client = new FixtureApiClient()
  installConnection(ctx, client, client.rpc)
}
