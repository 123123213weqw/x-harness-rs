import { z } from 'zod'
import type { Branded } from '../../client-connection/contracts/util/brand/index'

/** Stable identity shared by every attempt in one request-step retry chain. */
export type RetryId = Branded<'RetryId'>

/**
 * Brand an implementation-minted retry-chain identity.
 * @param id - opaque retry identity.
 * @returns the same string, branded; no validation is performed.
 */
export function RetryId(id: string): RetryId {
  return z.string().brand<'RetryId'>().parse(id)
}
