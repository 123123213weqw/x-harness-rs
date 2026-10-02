/** Browser face of the shared Typert runtime registry. */

import type { Context } from './context'
import { TypertRegistry } from './service'

/** Required services: none; this is the Client reflection root. */
export const inject: string[] = []

/**
 * Install the same registry implementation used by the Host face.
 * @param ctx - Client Cordis root.
 */
export function apply(ctx: Context): void {
  new TypertRegistry(ctx)
}
