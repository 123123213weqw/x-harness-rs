import { z } from 'zod'
import type { Branded } from '../../client-connection/contracts/util/brand/index'

/** Stable identity shared by one compact start/summary/checkpoint/end transaction. */
export type CompactionId = Branded<'CompactionId'>

/**
 * Brand an implementation-minted compaction identity.
 * @param id - opaque transaction identity.
 * @returns the same string, branded; no validation is performed.
 */
export function CompactionId(id: string): CompactionId {
  return z.string().brand<'CompactionId'>().parse(id)
}
